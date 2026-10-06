import { Server } from "socket.io";

import { MAX_BODY_BYTES } from "./httpApi.ts";

import type { Server as HttpServer } from "node:http";

type UserFollowPayload = {
  userToFollow: { socketId: string; username: string };
  action: "FOLLOW" | "UNFOLLOW";
};

const FOLLOW_ROOM_PREFIX = "follow@";

/**
 * Relays the (end-to-end encrypted) collaboration messages between the
 * clients of a room. Speaks the protocol of excalidraw/excalidraw-room,
 * which is what the Excalidraw app expects.
 */
export const attachRoomServer = (
  httpServer: HttpServer,
  { corsOrigin }: { corsOrigin: string | null },
) => {
  const io = new Server(httpServer, {
    transports: ["websocket", "polling"],
    cors: corsOrigin ? { origin: corsOrigin } : undefined,
    // a scene is broadcast in a single message
    maxHttpBufferSize: MAX_BODY_BYTES,
  });

  const getSocketIds = async (roomId: string) =>
    (await io.in(roomId).fetchSockets()).map((socket) => socket.id);

  io.on("connection", (socket) => {
    socket.emit("init-room");

    socket.on("join-room", async (roomId: string) => {
      await socket.join(roomId);
      const socketIds = await getSocketIds(roomId);

      if (socketIds.length <= 1) {
        socket.emit("first-in-room");
      } else {
        socket.broadcast.to(roomId).emit("new-user", socket.id);
      }

      io.in(roomId).emit("room-user-change", socketIds);
    });

    socket.on(
      "server-broadcast",
      (roomId: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socket.broadcast.to(roomId).emit("client-broadcast", encryptedData, iv);
      },
    );

    socket.on(
      "server-volatile-broadcast",
      (roomId: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
        socket.volatile.broadcast
          .to(roomId)
          .emit("client-broadcast", encryptedData, iv);
      },
    );

    socket.on("user-follow", async (payload: UserFollowPayload) => {
      const followedSocketId = payload?.userToFollow?.socketId;
      if (!followedSocketId) {
        return;
      }
      const followRoomId = `${FOLLOW_ROOM_PREFIX}${followedSocketId}`;

      if (payload.action === "FOLLOW") {
        await socket.join(followRoomId);
      } else if (payload.action === "UNFOLLOW") {
        await socket.leave(followRoomId);
      } else {
        return;
      }

      io.to(followedSocketId).emit(
        "user-follow-room-change",
        await getSocketIds(followRoomId),
      );
    });

    socket.on("disconnecting", async () => {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) {
          continue;
        }
        const otherSocketIds = (await getSocketIds(roomId)).filter(
          (socketId) => socketId !== socket.id,
        );

        if (roomId.startsWith(FOLLOW_ROOM_PREFIX)) {
          io.to(roomId.slice(FOLLOW_ROOM_PREFIX.length)).emit(
            "user-follow-room-change",
            otherSocketIds,
          );
        } else if (otherSocketIds.length > 0) {
          socket.broadcast.to(roomId).emit("room-user-change", otherSocketIds);
        }
      }
    });
  });

  return io;
};
