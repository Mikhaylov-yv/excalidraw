import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
  IV_LENGTH_BYTES,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// private
// -----------------------------------------------------------------------------

const STORAGE_BACKEND_URL = (
  import.meta.env.VITE_APP_STORAGE_BACKEND_URL || ""
).replace(/\/+$/, "");

// how many times we retry saving the scene when someone else has saved it
// between our read and write
const SAVE_SCENE_MAX_ATTEMPTS = 5;

const getSceneUrl = (roomId: string) =>
  `${STORAGE_BACKEND_URL}/rooms/${roomId}`;

const getFileUrl = (prefix: string, id: FileId) =>
  `${STORAGE_BACKEND_URL}/${prefix.replace(/^\/+|\/+$/g, "")}/${id}`;

/** The scene is stored as a single binary: IV followed by the ciphertext */
const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<Uint8Array<ArrayBuffer>> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  const buffer = new Uint8Array(iv.byteLength + encryptedBuffer.byteLength);
  buffer.set(iv);
  buffer.set(new Uint8Array(encryptedBuffer), iv.byteLength);

  return buffer;
};

const decryptElements = async (
  buffer: Uint8Array<ArrayBuffer>,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const iv = buffer.slice(0, IV_LENGTH_BYTES);
  const ciphertext = buffer.slice(IV_LENGTH_BYTES);

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class HttpStorageSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return HttpStorageSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    HttpStorageSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

// -----------------------------------------------------------------------------

export const isSavedToHttpStorage = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return HttpStorageSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToHttpStorage = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(getFileUrl(prefix, id), {
          method: "PUT",
          headers: { "Content-Type": MIME_TYPES.binary },
          body: buffer as Uint8Array<ArrayBuffer>,
        });
        if (!response.ok) {
          throw new Error(`Failed to save file (status ${response.status})`);
        }
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

/**
 * Reconciles the scene with the stored one and saves the result.
 *
 * The backend has no transactions, so the write is conditional on the stored
 * scene not having changed since we read it (ETag). On conflict we start over.
 */
export const saveToHttpStorage = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToHttpStorage(portal, elements)
  ) {
    return null;
  }

  const sceneUrl = getSceneUrl(roomId);

  for (let attempt = 0; attempt < SAVE_SCENE_MAX_ATTEMPTS; attempt++) {
    const prevResponse = await fetch(sceneUrl, { cache: "no-store" });

    let elementsToStore = elements;
    let precondition: Record<string, string>;

    if (prevResponse.status === 404) {
      precondition = { "If-None-Match": "*" };
    } else if (prevResponse.ok) {
      const etag = prevResponse.headers.get("ETag");
      if (!etag) {
        throw new Error("Storage backend did not return the scene ETag");
      }
      const prevStoredElements = getSyncableElements(
        restoreElements(
          await decryptElements(
            new Uint8Array(await prevResponse.arrayBuffer()),
            roomKey,
          ),
          null,
        ),
      );
      elementsToStore = getSyncableElements(
        reconcileElements(
          elements,
          prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
      precondition = { "If-Match": etag };
    } else {
      throw new Error(`Failed to load scene (status ${prevResponse.status})`);
    }

    const storedScene = await encryptElements(roomKey, elementsToStore);

    const response = await fetch(sceneUrl, {
      method: "PUT",
      headers: { ...precondition, "Content-Type": MIME_TYPES.binary },
      body: storedScene,
    });

    if (response.status === 412) {
      continue;
    }
    if (!response.ok) {
      throw new Error(`Failed to save scene (status ${response.status})`);
    }

    // Return the stored elements as the in memory `elementsToStore` could have mutated in the meantime
    const storedElements = getSyncableElements(
      restoreElements(await decryptElements(storedScene, roomKey), null),
    );

    HttpStorageSceneVersionCache.set(socket, storedElements);

    return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
  }

  throw new Error(
    `Failed to save scene (still conflicting after ${SAVE_SCENE_MAX_ATTEMPTS} attempts)`,
  );
};

export const loadFromHttpStorage = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const response = await fetch(getSceneUrl(roomId), { cache: "no-store" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load scene (status ${response.status})`);
  }
  const elements = getSyncableElements(
    restoreElements(
      await decryptElements(
        new Uint8Array(await response.arrayBuffer()),
        roomKey,
      ),
      null,
      {
        deleteInvisibleElements: true,
      },
    ),
  );

  if (socket) {
    HttpStorageSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromHttpStorage = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(getFileUrl(prefix, id));
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
