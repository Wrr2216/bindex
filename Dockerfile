# syntax=docker/dockerfile:1

# ---- build the client bundle and compile the server ----
FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY server/vendor ./server/vendor
COPY client/package.json client/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# ---- runtime: the server, its production dependencies, and the built client ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
# The canvas module used to render labels links against libstdc++ on Alpine.
RUN apk add --no-cache libstdc++
# Optional media tools. ffmpeg samples frames from walkthrough videos and takes
# the narration and step pictures out of teardown videos; pdftoppm (poppler)
# renders PDF manifests and receipts to page images for the vision model.
# Without them those features accept photos and images only.
RUN apk add --no-cache ffmpeg poppler-utils

# A standalone production install for the server alone, which keeps the client
# toolchain out of the image.
COPY server/package.json ./package.json
COPY server/vendor ./vendor
RUN pnpm install --prod --no-frozen-lockfile && pnpm store prune

COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/server/migrations ./migrations
COPY --from=builder /app/client/dist ./client-dist
# Large attachments are written here. Creating it owned by the app user means a
# fresh named volume mounted on top inherits that ownership.
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000
# Pending migrations are applied on boot, then the API and client are served.
CMD ["node", "dist/index.js"]
