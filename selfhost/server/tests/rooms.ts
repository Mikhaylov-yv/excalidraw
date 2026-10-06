import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";

import { io as connect } from "socket.io-client";

import { attachRoomServer } from "../src/rooms.ts";

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "socket.io-client";

describe("rooms", () => {
  let server: Server;
  let url: string;
  let sockets: Socket[] = [];

  /** resolves with the arguments of the next `event` the socket receives */
  const next = <T = unknown>(socket: Socket, event: string) =>
    new Promise<T[]>((resolve) => {
      socket.once(event, (...args: T[]) => resolve(args));
    });

  /** connects a client the way the app does and joins the room */
  const join = async (roomId: string) => {
    const socket = connect(url, { transports: ["websocket", "polling"] });
    sockets.push(socket);
    await next(socket, "init-room");
    socket.emit("join-room", roomId);
    return socket;
  };

  before(async () => {
    server = createServer();
    attachRoomServer(server, { corsOrigin: null });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    sockets.forEach((socket) => socket.close());
    sockets = [];
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("should tell the first client it is first in the room", async () => {
    const alice = await join("first");
    await next(alice, "first-in-room");
  });

  it("should announce a new client to the others", async () => {
    const alice = await join("announce");
    await next(alice, "first-in-room");

    const newUser = next<string>(alice, "new-user");
    const userChange = next<string[]>(alice, "room-user-change");
    const bob = await join("announce");

    assert.deepEqual(await newUser, [bob.id]);
    assert.deepEqual((await userChange)[0].sort(), [alice.id, bob.id].sort());
  });

  it("should relay broadcasts to the others in the room only", async () => {
    const alice = await join("relay");
    await next(alice, "first-in-room");
    const bob = await join("relay");
    await next(bob, "room-user-change");
    const carol = await join("another-room");
    await next(carol, "first-in-room");

    const received: string[] = [];
    alice.on("client-broadcast", () => received.push("alice"));
    carol.on("client-broadcast", () => received.push("carol"));

    const data = new Uint8Array([1, 2, 3]);
    const iv = new Uint8Array([4, 5]);

    const broadcast = next<Buffer>(bob, "client-broadcast");
    alice.emit("server-broadcast", "relay", data.buffer, iv);
    assert.deepEqual(
      (await broadcast).map((value) => [...new Uint8Array(value)]),
      [[...data], [...iv]],
    );

    const volatileBroadcast = next(bob, "client-broadcast");
    alice.emit("server-volatile-broadcast", "relay", data.buffer, iv);
    await volatileBroadcast;

    assert.deepEqual(received, []);
  });

  it("should tell the others when a client leaves", async () => {
    const alice = await join("leave");
    await next(alice, "first-in-room");
    const bob = await join("leave");
    await next(bob, "room-user-change");

    const userChange = next<string[]>(alice, "room-user-change");
    bob.close();

    assert.deepEqual(await userChange, [[alice.id]]);
  });

  it("should tell a client who follows them", async () => {
    const alice = await join("follow");
    await next(alice, "first-in-room");
    const bob = await join("follow");
    await next(bob, "room-user-change");

    const userToFollow = { socketId: alice.id, username: "alice" };

    let followedBy = next<string[]>(alice, "user-follow-room-change");
    bob.emit("user-follow", { userToFollow, action: "FOLLOW" });
    assert.deepEqual(await followedBy, [[bob.id]]);

    followedBy = next<string[]>(alice, "user-follow-room-change");
    bob.emit("user-follow", { userToFollow, action: "UNFOLLOW" });
    assert.deepEqual(await followedBy, [[]]);

    // a follower that disconnects stops following
    followedBy = next<string[]>(alice, "user-follow-room-change");
    bob.emit("user-follow", { userToFollow, action: "FOLLOW" });
    await followedBy;

    followedBy = next<string[]>(alice, "user-follow-room-change");
    bob.close();
    assert.deepEqual(await followedBy, [[]]);
  });
});
