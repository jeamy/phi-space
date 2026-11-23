# Multi-stage Dockerfile for PHI-SPACES / CODEMODE FORUM (Next.js 16 + React 19 + phi-spaces), taken over from
# codemode-chat/docker/Dockerfile and cut down: no sandbox, no Rust space server yet (phase 11 of
# docs/gemeinsame-planung-plan-2026-11-22.en.md).
# Build context: repository root.
# Targets:
#   - dev-test:   the test runner in Docker
#   - production: every role of the forum (space, sources, checker, agents, model, web) from one image: by default all
#                 of them in one container (server/launch.ts); docker/docker-compose.yml runs one container per role

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- Stage 1: dependencies (phi-spaces in spaces/ + codemode-forum Next.js/React) ----
FROM ${NODE_IMAGE} AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1
WORKDIR /opt/phi-spaces
COPY spaces/package.json spaces/package-lock.json ./spaces/
RUN --mount=type=cache,target=/root/.npm npm --prefix spaces ci --no-audit --no-fund
COPY codemode-forum/package.json codemode-forum/package-lock.json ./codemode-forum/
RUN --mount=type=cache,target=/root/.npm npm --prefix codemode-forum ci --no-audit --no-fund
# spaces/agent/src/live-models.ts (model access of the model process) needs the agent package's pi-ai
COPY spaces/agent/package.json spaces/agent/package-lock.json ./spaces/agent/
RUN --mount=type=cache,target=/root/.npm npm --prefix spaces/agent ci --no-audit --no-fund

# ---- Stage 2: builder (typecheck + Next.js production build) ----
FROM deps AS builder
WORKDIR /opt/phi-spaces
COPY spaces/tsconfig.json spaces/tsconfig.build.json ./spaces/
COPY spaces/src ./spaces/src
COPY spaces/agent/src ./spaces/agent/src
COPY codemode-forum ./codemode-forum
RUN npm --prefix codemode-forum run typecheck && npm --prefix codemode-forum run build

# ---- Stage 3: tests (`dev-test`); the sources tests build git repositories of their own ----
FROM builder AS dev-test
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=test FORUM_LLM=0 PORT=4100 FORUM_BIND=0.0.0.0
RUN mkdir -p /data /opt/phi-spaces/codemode-forum/.local && chown -R node:node /data /opt/phi-spaces
USER node
WORKDIR /opt/phi-spaces
CMD ["npm", "--prefix", "codemode-forum", "test"]

# ---- Stage 4: production (`production`): every role; the command picks one ----
FROM ${NODE_IMAGE} AS production
# the sources process reads repositories with git (objects of a commit, never a working tree). The repositories are
# mounted read-only and belong to another user, which git refuses by default: they are declared safe here, where
# nothing is ever executed from them.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*'
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1 \
    FORUM_BIND=0.0.0.0 \
    PORT=4100 \
    FORUM_SQLITE=/data/forum-space.sqlite
WORKDIR /opt/phi-spaces
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/package.json /opt/phi-spaces/spaces/package-lock.json ./spaces/
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/node_modules ./spaces/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/src ./spaces/src
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/agent/package.json /opt/phi-spaces/spaces/agent/package-lock.json ./spaces/agent/
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/agent/node_modules ./spaces/agent/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/spaces/agent/src ./spaces/agent/src
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-forum/package.json /opt/phi-spaces/codemode-forum/package-lock.json ./codemode-forum/
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-forum/node_modules ./codemode-forum/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-forum/next.config.mjs /opt/phi-spaces/codemode-forum/tsconfig.json ./codemode-forum/
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-forum/.next ./codemode-forum/.next
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-forum/app ./codemode-forum/app
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-forum/client ./codemode-forum/client
COPY --from=builder --chown=node:node /opt/phi-spaces/codemode-forum/server ./codemode-forum/server
RUN mkdir -p /data /repos && chown -R node:node /data
USER node
EXPOSE 4100 4180
WORKDIR /opt/phi-spaces/codemode-forum
# all roles in this one container; a role container runs its own server/<role>-host.ts (health checks: per service in
# docker-compose.yml, since a role container has no web page)
CMD ["node", "--no-warnings", "--experimental-strip-types", "server/launch.ts"]
