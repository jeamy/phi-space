# Image for every test bed container: Node plus the locked dependencies of pi-spaces.
# The sources are not baked in; they are synced to ./repo on the server and bind-mounted at /work.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# Dependencies only change with package*.json, so this layer is cached across syncs.
WORKDIR /opt/deps
COPY repo/package.json repo/package-lock.json ./
RUN npm ci

COPY entrypoint.sh /usr/local/bin/testbed-entrypoint
RUN chmod 755 /usr/local/bin/testbed-entrypoint && mkdir -p /work /data

WORKDIR /work
ENTRYPOINT ["testbed-entrypoint"]
# Containers idle; tests and host processes are started in them with `testbed.sh exec` / `test`.
CMD ["sleep", "infinity"]
