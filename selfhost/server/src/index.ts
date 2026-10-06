import { createServer } from "node:http";

import { createHttpApi } from "./httpApi.ts";
import { S3ObjectStore } from "./objectStore.ts";
import { attachRoomServer } from "./rooms.ts";

const env = (name: string, fallback?: string) => {
  const value = process.env[name] || fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
};

const PORT = Number(env("PORT", "3002"));
// only needed when the app is served from a different origin (development)
const CORS_ORIGIN = process.env.CORS_ORIGIN || null;

const store = new S3ObjectStore({
  endpoint: env("S3_ENDPOINT"),
  region: env("S3_REGION", "us-east-1"),
  bucket: env("S3_BUCKET"),
  accessKeyId: env("S3_ACCESS_KEY_ID"),
  secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
  forcePathStyle: env("S3_FORCE_PATH_STYLE", "true") === "true",
});

try {
  await store.ensureBucket();
} catch (error: any) {
  // the most likely reason for a deployment to fail, so make it easy to spot
  console.error(
    `Cannot access the S3 bucket "${env("S3_BUCKET")}" at ${env(
      "S3_ENDPOINT",
    )}: ${error?.name}: ${error?.message}`,
  );
  process.exit(1);
}

const httpServer = createServer(
  createHttpApi({ store, corsOrigin: CORS_ORIGIN }),
);
const io = attachRoomServer(httpServer, { corsOrigin: CORS_ORIGIN });

httpServer.listen(PORT, () => {
  console.info(`excalidraw-selfhost-server listening on :${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // closes the http server as well
    io.close(() => process.exit(0));
  });
}
