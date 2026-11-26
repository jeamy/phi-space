# The sites of spaces-files' replica test bed (testbed/replica/run.ts): Node with phi-spaces' sources and spaces-files'
# service. Built from a context run.ts assembles (spaces/ and spaces-files/, sources only), for this machine.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
COPY spaces /opt/spaces
COPY spaces-files /opt/spaces-files
RUN mkdir -p /opt/spaces-files/node_modules && ln -s /opt/spaces /opt/spaces-files/node_modules/phi-spaces
WORKDIR /opt/spaces-files
