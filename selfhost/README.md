# Self-hosted Excalidraw with sharing and collaboration

Everything needed to run Excalidraw on your own machine with share links and live collaboration working, and all the data stored locally:

- **app** — the Excalidraw app built to talk to the server below instead of excalidraw.com and Firebase ([app.Dockerfile](app.Dockerfile)),
- **server** — one small service ([server](server)) providing
  - share links (`#json=…`), the JSON backend of excalidraw.com,
  - collaboration rooms (`#room=…`), a socket.io relay speaking the protocol of [excalidraw-room](https://github.com/excalidraw/excalidraw-room),
  - storage of room scenes and image files in an S3-compatible storage,
- **rustfs** — the S3 (RustFS; MinIO or any other S3-compatible storage will do).

Everything the server stores or relays is end-to-end encrypted by the app. The keys live in the URL hash and never reach the server.

There is no authentication: whoever can reach the instance can use it, and whoever has a link can open the drawing. Run it inside your network.

## Running

```bash
cd selfhost
docker compose up -d --build
```

Excalidraw is then on http://localhost:8300. See [.env.example](.env.example) for the settings, including how to use an existing S3 instead of the bundled RustFS.

The app uses WebCrypto, which browsers only allow on `localhost` or over HTTPS. To use the instance from other machines, put it behind a TLS-terminating reverse proxy that also forwards WebSockets:

```nginx
location / {
    proxy_pass http://127.0.0.1:8300;
    proxy_set_header Host $host;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
    client_max_body_size 64m;
}
```

## Deploying to another network

Only the images have to be moved: the two built here and, unless an existing S3 is used, `rustfs/rustfs`. Either push the built ones to a registry reachable from there:

```bash
IMAGE_PREFIX=registry.example.com/tools/excalidraw IMAGE_TAG=1 docker compose build
IMAGE_PREFIX=registry.example.com/tools/excalidraw IMAGE_TAG=1 docker compose push app server
```

or carry them over as a file:

```bash
docker compose build
docker save excalidraw-selfhost-app excalidraw-selfhost-server rustfs/rustfs:1.0.1 | gzip > excalidraw-selfhost.tar.gz
# on the target machine
docker load < excalidraw-selfhost.tar.gz
```

On the target machine only `docker-compose.yml` and `.env` (with the same `IMAGE_PREFIX` and `IMAGE_TAG`) are needed:

```bash
docker compose up -d --no-build
```

The app image has the URLs of the server built in as relative ones, so the same image works under any domain. The app reaches the server at `EXCALIDRAW_SERVER_URL` (`http://server:3002` by default), which can be changed when the container is started.

## How the app is wired to the server

| Build-time variable            | Value           |
| ------------------------------ | --------------- |
| `VITE_APP_BACKEND_V2_GET_URL`  | `/api/v2/`      |
| `VITE_APP_BACKEND_V2_POST_URL` | `/api/v2/post/` |
| `VITE_APP_STORAGE_BACKEND_URL` | `/api/v2`       |
| `VITE_APP_WS_SERVER_URL`       | `/`             |

## Server API

All bodies are opaque binaries.

| Request |  |
| --- | --- |
| `POST /api/v2/post/` | stores a share link payload, responds with `{"id": "…"}` |
| `GET /api/v2/:id` | the share link payload |
| `GET /api/v2/rooms/:roomId` | the room scene, with its `ETag`; `404` if never saved |
| `PUT /api/v2/rooms/:roomId` | saves the room scene; requires `If-Match: <etag>` (update) or `If-None-Match: *` (create), responds with `412` if the scene has changed in the meantime |
| `PUT`, `GET /api/v2/files/rooms/:roomId/:fileId` | an image file of a room |
| `PUT`, `GET /api/v2/files/shareLinks/:id/:fileId` | an image file of a share link |
| `GET /healthz` | health check |

The conditional writes are what keeps concurrent clients from overwriting each other: the scene is encrypted, so the clients merge it themselves and may only replace the version they have seen. The server checks the precondition under a per-room lock, which makes it correct for a single server instance without requiring conditional writes from the S3.

## Server configuration

| Variable | Default |  |
| --- | --- | --- |
| `S3_ENDPOINT` | — | e.g. `http://rustfs:9000` |
| `S3_BUCKET` | — | created on start if missing |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — |  |
| `S3_REGION` | `us-east-1` |  |
| `S3_FORCE_PATH_STYLE` | `true` |  |
| `PORT` | `3002` |  |
| `CORS_ORIGIN` | — | only when the app is served from another origin, e.g. `http://localhost:3001` in development |

## Server development

Requires Node.js 22.18+ (the TypeScript sources are run as is).

```bash
cd selfhost/server
npm install
npm test
npm run typecheck
```
