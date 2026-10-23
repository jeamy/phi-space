# Multi-stage Dockerfile for PHI-SPACES / CODEMODE CHAT (Next.js 16 + React 19 + phi-spaces + pi-codemode)
# Build context: repository root.
# Targets:
#   - dev-test:   development processes / test runner in Docker
#   - production: every role of the chat (space, web, judge, agents, model) from one image: by default all of them in
#                 one container (server/launch.ts); docker/docker-compose.yml runs one container per role instead
# The servers are not bundled: pi-codemode needs its QuickJS wasm and worker file on disk.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- Stage 1: dependencies (root phi-spaces + codemode-chat Next.js/React) ----
FROM ${NODE_IMAGE} AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1
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
COPY agent/src/live-models.ts ./agent/src/live-models.ts
COPY codemode-chat ./codemode-chat
RUN npm --prefix codemode-chat run typecheck && npm --prefix codemode-chat run build

# ---- Stage 3: development & test (`dev-test`) ----
FROM builder AS dev-test
ENV NODE_ENV=test CODEMODE_CHAT_LLM=0 PORT=3700 CODEMODE_BIND=0.0.0.0
RUN mkdir -p /data /opt/phi-spaces/codemode-chat/.local && chown -R node:node /data /opt/phi-spaces
USER node
WORKDIR /opt/phi-spaces
CMD ["npm", "--prefix", "codemode-chat", "test"]

# ---- Stage 4: production (`production`): every role; the command picks one ----
FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1 \
    CODEMODE_BIND=0.0.0.0 \
    PORT=3700 \
    CODEMODE_SQLITE=/data/codemode-space.sqlite
WORKDIR /opt/phi-spaces
COPY --from=builder --chown=node:node /opt/phi-spaces/package.json /opt/phi-spaces/package-lock.json ./
COPY --from=builder --chown=node:node /opt/phi-spaces/node_modules ./node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/src ./src
COPY --from=builder --chown=node:node /opt/phi-spaces/agent/src ./agent/src
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/package.json /opt/phi-spaces/codemode-chat/package-lock.json ./codemode-chat/
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/node_modules ./codemode-chat/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/next.config.mjs /opt/phi-spaces/codemode-chat/tsconfig.json ./codemode-chat/
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/.next ./codemode-chat/.next
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/app ./codemode-chat/app
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/client ./codemode-chat/client
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/server ./codemode-chat/server
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3700 3800
WORKDIR /opt/phi-spaces/codemode-chat
# all roles in this one container; a role container runs its own server/<role>-host.ts (health checks: per service in
# docker-compose.yml, since a role container has no web page)
CMD ["node", "--no-warnings", "--experimental-strip-types", "server/launch.ts"]
