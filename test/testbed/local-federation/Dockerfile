# The federation of test/testbed/local-federation: Node with the sources, and the Rust server. Built from the checkout, for this machine.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUST_IMAGE=rust:1.99-bookworm

FROM ${RUST_IMAGE} AS rust-builder
WORKDIR /opt/phi-spaces/rust
COPY rust ./
RUN cargo build --release --locked -p phi-space-server

FROM ${NODE_IMAGE}
# ssh for the fence status of a data restore (src/fencing.ts): the client on the hosts, the server in `fence-ssh`
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client openssh-server && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/phi-spaces
COPY package.json ./
COPY src ./src
COPY test/testbed/local-federation ./test/testbed/local-federation
COPY --from=rust-builder /opt/phi-spaces/rust/target/release/phi-space-server /usr/local/bin/phi-space-server
