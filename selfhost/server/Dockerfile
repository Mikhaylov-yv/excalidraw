FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3002
EXPOSE 3002

USER node

HEALTHCHECK CMD wget -q -O /dev/null http://localhost:${PORT}/healthz || exit 1

# TypeScript is run as is (Node.js strips the types)
CMD ["node", "src/index.ts"]
