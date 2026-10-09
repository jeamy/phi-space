# Production-like image: Node, the production dependencies from the lock file and the BUILT artifacts of pi-spaces
# (the same pi-spaces.mjs bundle the mobile runtime gets, compiled examples and scenarios). No TypeScript source, no
# tests, no bind-mounted checkout. Built on the server from ./build, which build-artifacts.mjs fills.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# Dependencies only change with the manifests, so this layer is cached across artifact changes.
WORKDIR /opt/app
COPY build/package.json build/package-lock.json ./
RUN npm ci --omit=dev

COPY build/pi-spaces.mjs build/MANIFEST.json ./
COPY build/examples ./examples
COPY build/scenarios ./scenarios
COPY build/tools ./tools

# State lives in the /data volume and nowhere else; the process runs unprivileged.
RUN mkdir -p /data && chown node:node /data
USER node
# Containers idle; scenarios and, later, host processes are started in them with `testbed.sh exec` / `scenario`.
CMD ["sleep", "infinity"]
