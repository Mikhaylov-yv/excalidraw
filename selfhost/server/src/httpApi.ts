import { randomBytes } from "node:crypto";

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ObjectStore } from "./objectStore.ts";

const API_PREFIX = "/api/v2";

// Sanity cap so that a single request can't exhaust the memory. The app
// itself limits files to 4 MiB; scenes are JSON and far smaller than this.
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SHARE_LINK_ID_BYTES = 10;
// files are addressed by their content hash and never change
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const ID = "[a-zA-Z0-9_-]+";
const RE_SHARE_LINK = new RegExp(`^/(${ID})$`);
const RE_ROOM = new RegExp(`^/rooms/(${ID})$`);
const RE_FILE = new RegExp(`^/(files/(?:rooms|shareLinks)/${ID}/${ID})$`);

class HttpError extends Error {
  status: number;
  body: Record<string, string>;

  constructor(status: number, message: string, body?: Record<string, string>) {
    super(message);
    this.status = status;
    this.body = body ?? { error: message };
  }
}

const readBody = async (req: IncomingMessage) => {
  // the error class is what the Excalidraw app checks for
  const tooLarge = () =>
    new HttpError(413, "Request too large", {
      error_class: "RequestTooLargeError",
    });

  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
    throw tooLarge();
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/** Serializes async tasks per key (the server is the only writer to the S3) */
class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  };
}

export const createHttpApi = ({
  store,
  corsOrigin,
}: {
  store: ObjectStore;
  corsOrigin: string | null;
}) => {
  const roomLocks = new KeyedMutex();

  const sendJSON = (res: ServerResponse, status: number, body: object) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const sendObject = async (
    res: ServerResponse,
    key: string,
    cacheControl: string,
  ) => {
    const object = await store.get(key);
    if (!object) {
      throw new HttpError(404, "Not found");
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": object.body.byteLength,
      "Cache-Control": cacheControl,
      ETag: object.etag,
    });
    res.end(object.body);
  };

  const createShareLink = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const id = randomBytes(SHARE_LINK_ID_BYTES).toString("hex");
    await store.put(`shareLinks/${id}`, body);
    sendJSON(res, 200, { id });
  };

  /**
   * The clients reconcile the scene themselves (it's end-to-end encrypted),
   * so they may only overwrite the version of the scene they have seen.
   */
  const saveRoom = async (
    req: IncomingMessage,
    res: ServerResponse,
    roomId: string,
  ) => {
    const ifMatch = req.headers["if-match"];
    const ifNoneMatch = req.headers["if-none-match"];
    if (!ifMatch && ifNoneMatch !== "*") {
      throw new HttpError(428, "If-Match or If-None-Match: * is required");
    }

    const body = await readBody(req);
    const key = `rooms/${roomId}`;

    const etag = await roomLocks.run(key, async () => {
      const currentETag = await store.getETag(key);
      if (ifMatch ? ifMatch !== currentETag : currentETag !== null) {
        throw new HttpError(412, "The scene has changed");
      }
      return store.put(key, body);
    });

    res.writeHead(200, { ETag: etag });
    res.end();
  };

  const saveFile = async (
    req: IncomingMessage,
    res: ServerResponse,
    key: string,
  ) => {
    await store.put(key, await readBody(req));
    res.writeHead(200);
    res.end();
  };

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const { method } = req;

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/healthz" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (!pathname.startsWith(`${API_PREFIX}/`)) {
      throw new HttpError(404, "Not found");
    }
    const path = pathname.slice(API_PREFIX.length);

    if (/^\/post\/?$/.test(path) && method === "POST") {
      return createShareLink(req, res);
    }

    let match: RegExpMatchArray | null;

    if ((match = path.match(RE_ROOM))) {
      if (method === "GET") {
        return sendObject(res, `rooms/${match[1]}`, "no-store");
      }
      if (method === "PUT") {
        return saveRoom(req, res, match[1]);
      }
    } else if ((match = path.match(RE_FILE))) {
      if (method === "GET") {
        return sendObject(res, match[1], IMMUTABLE_CACHE_CONTROL);
      }
      if (method === "PUT") {
        return saveFile(req, res, match[1]);
      }
    } else if ((match = path.match(RE_SHARE_LINK)) && method === "GET") {
      return sendObject(res, `shareLinks/${match[1]}`, IMMUTABLE_CACHE_CONTROL);
    }

    throw new HttpError(404, "Not found");
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, If-Match, If-None-Match",
      );
      res.setHeader("Access-Control-Expose-Headers", "ETag");
    }

    try {
      await route(req, res);
    } catch (error: any) {
      if (!(error instanceof HttpError)) {
        console.error(`${req.method} ${req.url} failed:`, error);
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // the request body may not have been read
      res.setHeader("Connection", "close");
      if (error instanceof HttpError) {
        sendJSON(res, error.status, error.body);
      } else {
        sendJSON(res, 500, { error: "Internal server error" });
      }
    }
  };
};
