# Multi-stage Dockerfile for PHI-SPACES / CODEMODE CHAT (Next.js 16 + React 19 + phi-spaces + pi-codemode)
# Build context: repository root.
# Targets:
#   - dev-test:   development processes / test runner in Docker
#   - production: every role of the chat (space, web, judge, agents, model) from one image: by default all of them in
#                 one container (server/launch.ts); docker/docker-compose.yml runs one container per role instead
# The servers are not bundled: pi-codemode needs its QuickJS wasm and worker file on disk.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUST_IMAGE=rust:1.99-bookworm

# ---- Stage 1: dependencies (phi-spaces in spaces/ + codemode-chat Next.js/React) ----
FROM ${NODE_IMAGE} AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1
WORKDIR /opt/phi-spaces
COPY spaces/package.json spaces/package-lock.json ./spaces/
RUN --mount=type=cache,target=/root/.npm npm --prefix spaces ci --no-audit --no-fund
COPY codemode-chat/package.json codemode-chat/package-lock.json ./codemode-chat/
RUN --mount=type=cache,target=/root/.npm npm --prefix codemode-chat ci --no-audit --no-fund
# agent/src/live-models.ts (model access) needs the agent package's pi-ai
COPY spaces/agent/package.json spaces/agent/package-lock.json ./spaces/agent/
RUN --mount=type=cache,target=/root/.npm npm --prefix spaces/agent ci --no-audit --no-fund

# ---- Stage 2: builder (typecheck + Next.js production build) ----
FROM deps AS builder
WORKDIR /opt/phi-spaces
COPY spaces/tsconfig.json spaces/tsconfig.build.json ./spaces/
COPY spaces/src ./spaces/src
COPY spaces/agent/src ./spaces/agent/src
COPY spaces/agent/test/durable-models.ts ./spaces/agent/test/
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
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/package.json /opt/phi-spaces/spaces/package-lock.json ./spaces/
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/node_modules ./spaces/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/src ./spaces/src
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/agent/package.json /opt/phi-spaces/spaces/agent/package-lock.json ./spaces/agent/
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/agent/node_modules ./spaces/agent/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/agent/src ./spaces/agent/src
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/package.json /opt/phi-spaces/codemode-chat/package-lock.json ./codemode-chat/
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/node_modules ./codemode-chat/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/next.config.mjs /opt/phi-spaces/codemode-chat/tsconfig.json ./codemode-chat/
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/.next ./codemode-chat/.next
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/app ./codemode-chat/app
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/client ./codemode-chat/client
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/server ./codemode-chat/server
# the experiment documents and their figures, which the experiments pages render (server/experiments-content.ts)
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-chat/docs ./codemode-chat/docs
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3700 3800
WORKDIR /opt/phi-spaces/codemode-chat
# all roles in this one container; a role container runs its own server/<role>-host.ts (health checks: per service in
# docker-compose.yml, since a role container has no web page)
CMD ["node", "--no-warnings", "--experimental-strip-types", "server/launch.ts"]

# ---- Stage 5: production-rust: the production image with the Rust space server (docs/rust-portierung.en.md, R4) ----
# docker-compose.rust.yml gives it to the space containers; the other roles and every other command stay as they are.
# The builder is Debian bookworm like the Node image, so the binary finds the same libc.
FROM ${RUST_IMAGE} AS rust-builder
# The application's own workspace (codemode-chat/rust) takes the core crates as path dependencies from spaces/rust: both are
# copied with the layout of the checkout (docs/umstellung-verzeichnisse.en.md, D1).
WORKDIR /opt/phi-spaces
COPY spaces/rust ./spaces/rust
COPY codemode-chat/rust ./codemode-chat/rust
WORKDIR /opt/phi-spaces/codemode-chat/rust
RUN cargo build --release --locked -p codemode-space

FROM production AS production-rust
COPY --from=rust-builder /opt/phi-spaces/codemode-chat/rust/target/release/codemode-space /usr/local/bin/codemode-space
