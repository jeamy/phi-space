# Multi-stage Dockerfile for PHI-SPACES / CODEMODE CHAT (Next.js 16 + React 19 + phi-spaces + pi-codemode)
# Build context: repository root.
# Targets:
#   - dev-test:   development server / test runner in Docker
#   - production: the hub ("big"): Next.js server + API + WebSocket + SQLite in /data
#   - nano:       headless judge shard ("nano"): its own space + sandbox judges, served over the phi-spaces socket
# The servers are not bundled: pi-codemode needs its QuickJS wasm and worker file on disk.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- Stage 1: dependencies (root phi-spaces + codemode-chat Next.js/React) ----
FROM ${NODE_IMAGE} AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
WORKDIR /opt/phi-spaces
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY codemode-chat/package.json codemode-chat/package-lock.json ./codemode-chat/
RUN --mount=type=cache,target=/root/.npm npm --prefix codemode-chat ci --no-audit --no-fund

# ---- Stage 2: builder (typecheck + Next.js production build) ----
FROM deps AS builder
WORKDIR /opt/phi-spaces
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY examples/live-models.ts ./examples/live-models.ts
COPY codemode-chat ./codemode-chat
RUN npm --prefix codemode-chat run typecheck && npm --prefix codemode-chat run build

# ---- Stage 3: development & test (`dev-test`) ----
FROM builder AS dev-test
ENV NODE_ENV=test CODEMODE_CHAT_LLM=0 PORT=3700 CODEMODE_BIND=0.0.0.0
RUN mkdir -p /data /opt/phi-spaces/codemode-chat/.local && chown -R node:node /data /opt/phi-spaces
USER node
WORKDIR /opt/phi-spaces
CMD ["npm", "--prefix", "codemode-chat", "test"]

# ---- Stage 4: production hub (`production`) ----
FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false \
    CODEMODE_BIND=0.0.0.0 \
    PORT=3700 \
    CODEMODE_SQLITE=/data/codemode-chat.sqlite
WORKDIR /opt/phi-spaces
COPY --from=builder --chown=node:node /opt/phi-spaces/package.json /opt/phi-spaces/package-lock.json ./
COPY --from=builder --chown=node:node /opt/phi-spaces/node_modules ./node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/src ./src
COPY --from=builder --chown=node:node /opt/phi-spaces/examples ./examples
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/package.json /opt/phi-spaces/codemode-chat/package-lock.json ./codemode-chat/
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/node_modules ./codemode-chat/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/next.config.mjs /opt/phi-spaces/codemode-chat/tsconfig.json ./codemode-chat/
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/.next ./codemode-chat/.next
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/app ./codemode-chat/app
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/client ./codemode-chat/client
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/server ./codemode-chat/server
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3700
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3700) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
WORKDIR /opt/phi-spaces/codemode-chat
CMD ["node", "--no-warnings", "--experimental-strip-types", "server/index.ts"]

# ---- Stage 5: headless judge shard (`nano`) for the big/nano two-host setup ----
# Same sources and node_modules as production, but only the shard: space + judge workers over the phi-spaces socket
# (no Next.js, no HTTP layer).
FROM production AS nano
ENV CODEMODE_LISTEN=tcp:0.0.0.0:3800 \
    CODEMODE_DB=/data/codemode-b.sqlite
EXPOSE 3800
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const s=require('net').connect(3800,'127.0.0.1');s.once('connect',()=>{s.end();process.exit(0)});s.once('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000)"]
CMD ["node", "--no-warnings", "--experimental-strip-types", "server/nano-host.ts"]
