# Codemode chat: standalone container (no Next.js, no build step: plain Node + a static client).
# Build context: repository root. The server needs the phi-spaces sources (src, examples/live-models.ts) and the
# root dependencies, including @earendil-works/pi-codemode (its QuickJS wasm and worker file must stay on disk,
# so the server is not bundled).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
WORKDIR /opt/phi-spaces
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production \
    PORT=3700 \
    CODEMODE_BIND=0.0.0.0 \
    CODEMODE_SQLITE=/data/codemode-chat.sqlite
WORKDIR /opt/phi-spaces
COPY --from=deps --chown=node:node /opt/phi-spaces/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node examples/live-models.ts ./examples/live-models.ts
COPY --chown=node:node codemode-chat/server ./codemode-chat/server
COPY --chown=node:node codemode-chat/client ./codemode-chat/client
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3700
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3700) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "--no-warnings", "--experimental-strip-types", "codemode-chat/server/index.ts"]
