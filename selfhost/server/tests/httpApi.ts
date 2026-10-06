import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";

import { createHttpApi, MAX_BODY_BYTES } from "../src/httpApi.ts";

import { MemoryObjectStore } from "../src/objectStore.ts";

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

describe("http api", () => {
  let server: Server;
  let api: string;

  const bytes = (...values: number[]) => new Uint8Array(values);
  const getBytes = async (response: Response) =>
    new Uint8Array(await response.arrayBuffer());

  before(async () => {
    server = createServer(
      createHttpApi({
        store: new MemoryObjectStore(),
        corsOrigin: "http://localhost:3001",
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    api = `http://localhost:${(server.address() as AddressInfo).port}/api/v2`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  describe("share links", () => {
    it("should store the payload and return it by id", async () => {
      const post = await fetch(`${api}/post/`, {
        method: "POST",
        body: bytes(1, 2, 3),
      });
      const { id } = (await post.json()) as { id: string };
      // the id has to fit the `#json=<id>,<key>` links of the app
      assert.match(id, /^[a-zA-Z0-9_-]+$/);

      const get = await fetch(`${api}/${id}`);
      assert.equal(get.status, 200);
      assert.deepEqual(await getBytes(get), bytes(1, 2, 3));
    });

    it("should return 404 for an unknown id", async () => {
      assert.equal((await fetch(`${api}/unknown`)).status, 404);
    });

    it("should reject too large payloads the way the app expects", async () => {
      const response = await fetch(`${api}/post/`, {
        method: "POST",
        body: new Uint8Array(MAX_BODY_BYTES + 1),
      });
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), {
        error_class: "RequestTooLargeError",
      });
    });
  });

  describe("rooms", () => {
    const put = (
      roomId: string,
      body: Uint8Array,
      headers: Record<string, string>,
    ) => fetch(`${api}/rooms/${roomId}`, { method: "PUT", body, headers });

    it("should return 404 for a room that was never saved", async () => {
      assert.equal((await fetch(`${api}/rooms/missing`)).status, 404);
    });

    it("should create a room only if it doesn't exist", async () => {
      const created = await put("create", bytes(1), { "If-None-Match": "*" });
      assert.equal(created.status, 200);
      assert.ok(created.headers.get("ETag"));

      const again = await put("create", bytes(2), { "If-None-Match": "*" });
      assert.equal(again.status, 412);

      const get = await fetch(`${api}/rooms/create`);
      assert.deepEqual(await getBytes(get), bytes(1));
      assert.equal(get.headers.get("ETag"), created.headers.get("ETag"));
      assert.equal(get.headers.get("Cache-Control"), "no-store");
    });

    it("should update a room only if it hasn't changed", async () => {
      const created = await put("update", bytes(1), { "If-None-Match": "*" });
      const etag = created.headers.get("ETag")!;

      const updated = await put("update", bytes(2), { "If-Match": etag });
      assert.equal(updated.status, 200);
      assert.notEqual(updated.headers.get("ETag"), etag);

      // `etag` is stale now
      const stale = await put("update", bytes(3), { "If-Match": etag });
      assert.equal(stale.status, 412);

      assert.deepEqual(
        await getBytes(await fetch(`${api}/rooms/update`)),
        bytes(2),
      );
    });

    it("should not update a room that doesn't exist", async () => {
      const response = await put("nonexistent", bytes(1), {
        "If-Match": '"abc"',
      });
      assert.equal(response.status, 412);
    });

    it("should let only one of concurrent writers win", async () => {
      const created = await put("race", bytes(0), { "If-None-Match": "*" });
      const etag = created.headers.get("ETag")!;

      const responses = await Promise.all(
        [1, 2, 3, 4, 5].map((value) =>
          put("race", bytes(value), { "If-Match": etag }),
        ),
      );

      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [200, 412, 412, 412, 412],
      );
    });

    it("should require a precondition", async () => {
      assert.equal((await put("unconditional", bytes(1), {})).status, 428);
    });
  });

  describe("files", () => {
    it("should store files per room", async () => {
      const url = `${api}/files/rooms/room1/file1`;
      const put = await fetch(url, { method: "PUT", body: bytes(1, 2) });
      assert.equal(put.status, 200);

      const get = await fetch(url);
      assert.deepEqual(await getBytes(get), bytes(1, 2));
      assert.match(get.headers.get("Cache-Control")!, /immutable/);

      // the same file id in another room is a different (differently
      // encrypted) file
      assert.equal((await fetch(`${api}/files/rooms/room2/file1`)).status, 404);
    });

    it("should store files of share links", async () => {
      const url = `${api}/files/shareLinks/link1/file1`;
      await fetch(url, { method: "PUT", body: bytes(7) });
      assert.deepEqual(await getBytes(await fetch(url)), bytes(7));
    });

    it("should reject paths outside of the known prefixes", async () => {
      for (const path of [
        "files/other/room1/file1",
        "files/rooms/file1",
        "files/rooms/room1/..%2F..%2Fsecret",
      ]) {
        const response = await fetch(`${api}/${path}`, {
          method: "PUT",
          body: bytes(1),
        });
        assert.equal(response.status, 404, path);
      }
    });
  });

  it("should answer CORS preflights", async () => {
    const response = await fetch(`${api}/rooms/room1`, { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      "http://localhost:3001",
    );
    assert.match(
      response.headers.get("Access-Control-Allow-Headers")!,
      /If-Match/,
    );
  });

  it("should report health", async () => {
    const response = await fetch(new URL("/healthz", api));
    assert.equal(response.status, 200);
  });
});
