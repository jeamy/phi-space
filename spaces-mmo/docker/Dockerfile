# Multi-stage Dockerfile for spaces-mmo (Next.js 16 + React 19 + PixiJS + phi-spaces), like codemode-chat/docker/Dockerfile.
# Build context: repository root.
# Targets:
#   - dev-test:   the test suite in Docker
#   - production: every role (space, world, npc, web) from one image: by default all of them in one container
#                 (server/launch.ts); docker/docker-compose.yml runs one container per role instead
# server/llm.ts (model NPCs, off unless SPACES_MMO_LLM is on) loads agent/src/live-models.ts, which needs the agent
# package's pi-ai: the image carries both, as the codemode-chat image does.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUST_IMAGE=rust:1.99-bookworm

# ---- Stage 1: dependencies (root phi-spaces + spaces-mmo Next.js/React/PixiJS) ----
FROM ${NODE_IMAGE} AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1
WORKDIR /opt/phi-spaces
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY spaces-mmo/package.json spaces-mmo/package-lock.json ./spaces-mmo/
RUN --mount=type=cache,target=/root/.npm npm --prefix spaces-mmo ci --no-audit --no-fund
COPY agent/package.json agent/package-lock.json ./agent/
RUN --mount=type=cache,target=/root/.npm npm --prefix agent ci --no-audit --no-fund

# ---- Stage 2: builder (typecheck + Next.js production build) ----
FROM deps AS builder
WORKDIR /opt/phi-spaces
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY agent/src ./agent/src
COPY agent/test/durable-npc-models.ts ./agent/test/
COPY spaces-mmo ./spaces-mmo
RUN npm --prefix spaces-mmo run typecheck && npm --prefix spaces-mmo run build

# ---- Stage 3: tests (`dev-test`) ----
FROM builder AS dev-test
ENV NODE_ENV=test PORT=3900 SPACES_MMO_BIND=0.0.0.0
RUN mkdir -p /data /opt/phi-spaces/spaces-mmo/.local && chown -R node:node /data /opt/phi-spaces
USER node
WORKDIR /opt/phi-spaces
CMD ["npm", "--prefix", "spaces-mmo", "test"]

# ---- Stage 4: production (`production`): every role; the command picks one ----
FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1 \
    SPACES_MMO_BIND=0.0.0.0 \
    PORT=3900 \
    SPACES_MMO_DATA=/data
WORKDIR /opt/phi-spaces
COPY --from=builder --chown=node:node /opt/phi-spaces/package.json /opt/phi-spaces/package-lock.json ./
COPY --from=builder --chown=node:node /opt/phi-spaces/node_modules ./node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/src ./src
COPY --from=builder --chown=node:node /opt/phi-spaces/agent/package.json /opt/phi-spaces/agent/package-lock.json ./agent/
COPY --from=builder --chown=node:node /opt/phi-spaces/agent/node_modules ./agent/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/agent/src ./agent/src
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces-mmo/package.json /opt/phi-spaces/spaces-mmo/package-lock.json ./spaces-mmo/
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces-mmo/node_modules ./spaces-mmo/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces-mmo/next.config.mjs /opt/phi-spaces/spaces-mmo/tsconfig.json ./spaces-mmo/
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces-mmo/.next ./spaces-mmo/.next
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces-mmo/app ./spaces-mmo/app
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces-mmo/client ./spaces-mmo/client
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces-mmo/server ./spaces-mmo/server
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces-mmo/worlds ./spaces-mmo/worlds
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3900 3950 3951
WORKDIR /opt/phi-spaces/spaces-mmo
# all roles in this one container; a role container runs its own server/<role>-host.ts (health checks: per service in
# docker-compose.yml)
CMD ["node", "--no-warnings", "--experimental-strip-types", "server/launch.ts"]

# ---- Stage 5: production-rust: the production image with the Rust space server (docs/rust-portierung.md, R4) ----
# docker-compose.rust.yml gives it to the space containers; the other roles and every other command stay as they are.
# The builder is Debian bookworm like the Node image, so the binary finds the same libc.
FROM ${RUST_IMAGE} AS rust-builder
WORKDIR /opt/phi-spaces/rust
COPY rust ./
RUN cargo build --release --locked -p phi-space-server

FROM production AS production-rust
COPY --from=rust-builder /opt/phi-spaces/rust/target/release/phi-space-server /usr/local/bin/phi-space-server
