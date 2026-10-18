# Multi-Stage Dockerfile for PHI-SPACES / HELP (Next.js 16.4 + React 19.3 + phi-spaces)
# Build context: repository root (/media/data/programming/phi-spaces)
# Targets:
#   - dev-test:   Local development & automated test runner in Docker
#   - production: Hardened production server for https://spaces.eibrain.org

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- Stage 1: Base dependencies (root phi-spaces + help-site Next.js/React) ----
FROM ${NODE_IMAGE} AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false \
    NODE_OPTIONS=--dns-result-order=ipv4first \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
WORKDIR /opt/phi-spaces

# Prefer IPv4 for npm registry lookups (IPv6 often breaks npm ci in Docker builds)
RUN printf 'precedence ::ffff:0:0/96  100\n' >> /etc/gai.conf

COPY package.json package-lock.json ./
RUN npm ci

COPY help-site/package.json help-site/package-lock.json ./help-site/
RUN npm --prefix help-site ci

# ---- Stage 2: Builder (Corpus generation + Next.js 16 Production Build + esbuild bundle) ----
FROM deps AS builder
WORKDIR /opt/phi-spaces

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY examples ./examples
COPY help-site ./help-site

# Generate bilingual Help corpus (DE/EN), standalone React bundle, and Next.js 16 production build
RUN npm --prefix help-site run build

# ---- Stage 3: Local Dev & Test Docker Environment (`dev-test`) ----
FROM builder AS dev-test
ENV NODE_ENV=test \
    PHI_SPACES_LLM=0 \
    PHI_SPACES_TEST_NEXT=1 \
    HELP_BIND=0.0.0.0 \
    PORT=3500 \
    HELP_PORT=3500
RUN mkdir -p /data /opt/phi-spaces/help-site/.local && \
    chown -R node:node /data /opt/phi-spaces
USER node
WORKDIR /opt/phi-spaces
CMD ["npm", "--prefix", "help-site", "test"]

# ---- Stage 4: Hardened Production Image (`production`) for https://spaces.eibrain.org ----
FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    HELP_BIND=0.0.0.0 \
    PORT=3500 \
    HELP_PORT=3500 \
    HELP_SQLITE=/data/spaces-eibrain.sqlite

WORKDIR /opt/phi-spaces

# Copy production runtime dependencies and built artifacts
COPY --from=builder --chown=node:node /opt/phi-spaces/package.json /opt/phi-spaces/package-lock.json ./
COPY --from=builder --chown=node:node /opt/phi-spaces/node_modules ./node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/src ./src
COPY --from=builder --chown=node:node /opt/phi-spaces/examples ./examples
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/package.json /opt/phi-spaces/help-site/package-lock.json ./help-site/
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/node_modules ./help-site/node_modules
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/next.config.mjs /opt/phi-spaces/help-site/tsconfig.json ./help-site/
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/.next ./help-site/.next
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/public ./help-site/public
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/dist ./help-site/dist
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/corpus ./help-site/corpus
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/app ./help-site/app
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/client ./help-site/client
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/examples ./help-site/examples
COPY --from=builder --chown=node:node /opt/phi-spaces/help-site/server ./help-site/server

RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3500

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3500) + '/help/index.json').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "--no-warnings", "--experimental-strip-types", "help-site/server/index.ts"]

# ---- Stage 5: Headless Swarm Shard Host (`nano`) for the big/nano two-host setup ----
# Same sources + node_modules as production, but runs only the shard engine
# (space + workers over phi-spaces socket) — no Next.js, no HTTP layer.
FROM production AS nano
ENV SWARM_LISTEN=tcp:0.0.0.0:3600 \
    SWARM_DB=/data/swarm-b.sqlite \
    SWARM_TAG=b-
EXPOSE 3600

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const s=require('net').connect(3600,'127.0.0.1');s.once('connect',()=>{s.end();process.exit(0)});s.once('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000)"]

CMD ["node", "--no-warnings", "--experimental-strip-types", "help-site/server/nano-host.ts"]
