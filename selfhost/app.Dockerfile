# The Excalidraw app built for self-hosting, served by nginx together with
# a reverse proxy to the server (see ./server). Build from the repository root:
#
#   docker build -f selfhost/app.Dockerfile .

FROM --platform=${BUILDPLATFORM} node:24 AS build

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --frozen-lockfile --network-timeout 600000

# The app and the server share the origin, hence the relative URLs.
# The AI backend is the one of excalidraw.com, so it's turned off.
ENV VITE_APP_BACKEND_V2_GET_URL=/api/v2/ \
    VITE_APP_BACKEND_V2_POST_URL=/api/v2/post/ \
    VITE_APP_STORAGE_BACKEND_URL=/api/v2 \
    VITE_APP_WS_SERVER_URL=/ \
    VITE_APP_FIREBASE_CONFIG={} \
    VITE_APP_AI_BACKEND=

RUN npm_config_target_arch=${TARGETARCH} yarn build:app:docker

FROM nginx:stable-alpine-slim

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html

# where the server is reachable from this container
ENV EXCALIDRAW_SERVER_URL=http://server:3002
# makes the entrypoint export the DNS servers of the container as
# NGINX_LOCAL_RESOLVERS, for the `resolver` below
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

# rendered into /etc/nginx/conf.d/ when the container starts
COPY <<'EOF' /etc/nginx/templates/default.conf.template
server {
  listen 80;
  listen [::]:80;

  root /usr/share/nginx/html;
  index index.html;

  # keep in sync with MAX_BODY_BYTES of the server
  client_max_body_size 64m;

  # The server address is a variable so that nginx resolves it per request
  # (and not once on start): the server container gets a new IP address
  # whenever it's recreated, e.g. on deployment.
  resolver ${NGINX_LOCAL_RESOLVERS} valid=10s;
  set $excalidraw_server ${EXCALIDRAW_SERVER_URL};

  location /api/v2/ {
    proxy_pass $excalidraw_server;
    proxy_set_header Host $host;
  }

  location /socket.io/ {
    proxy_pass $excalidraw_server;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
  }
}
EOF

HEALTHCHECK CMD wget -q -O /dev/null http://localhost || exit 1
