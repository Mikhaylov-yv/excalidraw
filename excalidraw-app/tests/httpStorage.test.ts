import { webcrypto } from "node:crypto";

import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { compressData } from "@excalidraw/excalidraw/data/encode";
import { generateEncryptionKey } from "@excalidraw/excalidraw/data/encryption";
import { syncInvalidIndices } from "@excalidraw/element";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { vi } from "vitest";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { AppState, DataURL } from "@excalidraw/excalidraw/types";

import { getSyncableElements } from "../data";
import {
  isSavedToHttpStorage,
  loadFilesFromHttpStorage,
  loadFromHttpStorage,
  saveFilesToHttpStorage,
  saveToHttpStorage,
} from "../data/httpStorage";

import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// the backend URL is read when the module is imported
const { STORAGE_BACKEND_URL } = vi.hoisted(() => {
  const STORAGE_BACKEND_URL = "https://storage.test/api/v2";
  vi.stubEnv("VITE_APP_STORAGE_BACKEND_URL", `${STORAGE_BACKEND_URL}/`);
  return { STORAGE_BACKEND_URL };
});

/**
 * In-memory stand-in for the storage backend, implementing the conditional
 * writes (ETag / If-Match / If-None-Match) the scene saving relies on.
 */
class FakeStorageBackend {
  objects = new Map<string, { body: Uint8Array<ArrayBuffer>; etag: string }>();
  requests: { method: string; url: string; headers: Headers }[] = [];
  /** runs once right before the next PUT is applied, to simulate a race */
  beforeNextPut: (() => Promise<void>) | null = null;

  private version = 0;

  fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    this.requests.push({ method, url, headers });

    if (method === "GET") {
      const object = this.objects.get(url);
      return object
        ? new Response(object.body, { headers: { ETag: object.etag } })
        : new Response(null, { status: 404 });
    }

    if (this.beforeNextPut) {
      const beforeNextPut = this.beforeNextPut;
      this.beforeNextPut = null;
      await beforeNextPut();
    }

    const object = this.objects.get(url);
    const ifMatch = headers.get("If-Match");
    if (
      (headers.get("If-None-Match") === "*" && object) ||
      (ifMatch && ifMatch !== object?.etag)
    ) {
      return new Response(null, { status: 412 });
    }

    const etag = `"${++this.version}"`;
    this.objects.set(url, {
      body: new Uint8Array(init!.body as Uint8Array<ArrayBuffer>),
      etag,
    });
    return new Response(null, { headers: { ETag: etag } });
  };
}

const createElements = (...ids: string[]) =>
  getSyncableElements(
    syncInvalidIndices(
      ids.map((id) => API.createElement({ type: "rectangle", id })),
    ),
  );

const getIds = (elements: readonly ExcalidrawElement[] | null) =>
  elements?.map((element) => element.id);

describe("http storage", () => {
  const appState = getDefaultAppState() as AppState;

  let backend: FakeStorageBackend;
  let roomKey: string;

  const createPortal = (roomId = "room1") =>
    ({ socket: {} as Socket, roomId, roomKey } as Portal);

  beforeAll(async () => {
    // jsdom doesn't implement SubtleCrypto
    Object.defineProperty(window, "crypto", { value: webcrypto });

    roomKey = await generateEncryptionKey();
  });

  beforeEach(() => {
    backend = new FakeStorageBackend();
    vi.stubGlobal("fetch", backend.fetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("should return null when the room was never saved", async () => {
    expect(await loadFromHttpStorage("room1", roomKey, null)).toBeNull();
  });

  it("should create the scene and load it back", async () => {
    const portal = createPortal();
    const elements = createElements("A", "B");

    expect(isSavedToHttpStorage(portal, elements)).toBe(false);

    const storedElements = await saveToHttpStorage(portal, elements, appState);

    expect(getIds(storedElements)).toEqual(["A", "B"]);
    expect(isSavedToHttpStorage(portal, elements)).toBe(true);

    const put = backend.requests.find((request) => request.method === "PUT")!;
    expect(put.url).toBe(`${STORAGE_BACKEND_URL}/rooms/room1`);
    expect(put.headers.get("If-None-Match")).toBe("*");

    // the scene is encrypted, so the backend must not see the plaintext
    const { body } = backend.objects.get(put.url)!;
    expect(new TextDecoder().decode(body)).not.toContain("rectangle");

    expect(getIds(await loadFromHttpStorage("room1", roomKey, null))).toEqual([
      "A",
      "B",
    ]);
  });

  it("should not save again when the scene hasn't changed", async () => {
    const portal = createPortal();
    const elements = createElements("A");

    await saveToHttpStorage(portal, elements, appState);
    backend.requests = [];

    expect(await saveToHttpStorage(portal, elements, appState)).toBeNull();
    expect(backend.requests).toEqual([]);
  });

  it("should reconcile with the stored scene", async () => {
    await saveToHttpStorage(createPortal(), createElements("A"), appState);

    const storedElements = await saveToHttpStorage(
      createPortal(),
      createElements("B"),
      appState,
    );

    expect(getIds(storedElements)?.sort()).toEqual(["A", "B"]);

    const put = backend.requests.filter(({ method }) => method === "PUT")[1];
    expect(put.headers.get("If-Match")).toBe('"1"');
  });

  it("should retry when the scene was saved by someone else in the meantime", async () => {
    await saveToHttpStorage(createPortal(), createElements("A"), appState);

    backend.beforeNextPut = async () => {
      await saveToHttpStorage(createPortal(), createElements("B"), appState);
    };

    const storedElements = await saveToHttpStorage(
      createPortal(),
      createElements("C"),
      appState,
    );

    // nobody's elements got lost
    expect(getIds(storedElements)?.sort()).toEqual(["A", "B", "C"]);
    expect(
      getIds(await loadFromHttpStorage("room1", roomKey, null))?.sort(),
    ).toEqual(["A", "B", "C"]);
  });

  it("should give up when the scene keeps conflicting", async () => {
    const conflict = async () => new Response(null, { status: 412 });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "PUT" ? conflict() : backend.fetch(input, init),
    );

    await expect(
      saveToHttpStorage(createPortal(), createElements("A"), appState),
    ).rejects.toThrow(/conflicting/);
  });

  it("should throw when the backend fails", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    await expect(loadFromHttpStorage("room1", roomKey, null)).rejects.toThrow(
      /status 500/,
    );
    await expect(
      saveToHttpStorage(createPortal(), createElements("A"), appState),
    ).rejects.toThrow(/status 500/);
  });

  it("should save files under the prefix and load them back", async () => {
    const id = "file1" as FileId;
    const dataURL = "data:image/png;base64,AAAA" as DataURL;
    const buffer = await compressData(new TextEncoder().encode(dataURL), {
      encryptionKey: roomKey,
      metadata: { id, mimeType: "image/png", created: 1, lastRetrieved: 1 },
    });

    expect(
      await saveFilesToHttpStorage({
        prefix: "/files/rooms/room1",
        files: [{ id, buffer }],
      }),
    ).toEqual({ savedFiles: [id], erroredFiles: [] });

    expect([...backend.objects.keys()]).toEqual([
      `${STORAGE_BACKEND_URL}/files/rooms/room1/file1`,
    ]);

    const { loadedFiles, erroredFiles } = await loadFilesFromHttpStorage(
      "files/rooms/room1",
      roomKey,
      [id, "missing" as FileId],
    );

    expect(loadedFiles).toEqual([
      expect.objectContaining({ id, dataURL, mimeType: "image/png" }),
    ]);
    expect([...erroredFiles.keys()]).toEqual(["missing"]);
  });

  it("should report the files that failed to save", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));

    expect(
      await saveFilesToHttpStorage({
        prefix: "/files/rooms/room1",
        files: [{ id: "file1" as FileId, buffer: new Uint8Array(1) }],
      }),
    ).toEqual({ savedFiles: [], erroredFiles: ["file1"] });
  });
});
