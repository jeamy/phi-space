# The production image of spaces-files (docs/zanzibar-agent-filesystem-plan.en.md, section 8; spaces-files/docs/
# operator-guide.en.md, section 11): the filesystem service in Node and its Space process in Rust (files-space, R-D12:
# on big and nano only the Rust Space servers run). Build context: the repository root (its .dockerignore).
# The service needs no npm package beside phi-spaces, whose sources it runs directly; nothing is installed.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUST_IMAGE=rust:1.99-bookworm

# The builder is Debian bookworm like the Node image, so the binary finds the same libc. The application's workspace
# takes the core crates as path dependencies from spaces/rust: both with the layout of the checkout.
FROM ${RUST_IMAGE} AS rust-builder
WORKDIR /opt/phi-spaces
COPY spaces/rust ./spaces/rust
COPY spaces-files/rust ./spaces-files/rust
WORKDIR /opt/phi-spaces/spaces-files/rust
RUN cargo build --release --locked -p files-space

FROM ${NODE_IMAGE} AS production
ENV NODE_ENV=production \
    FILES_DATA_DIR=/srv/files/data FILES_STATE_DIR=/srv/files/state FILES_BLOB_DIR=/srv/files/blobs \
    FILES_SPACE_SERVER=/usr/local/bin/files-space
WORKDIR /opt/phi-spaces
COPY spaces/package.json ./spaces/
COPY spaces/src ./spaces/src
COPY spaces-files/package.json ./spaces-files/
COPY spaces-files/server ./spaces-files/server
COPY spaces-files/client ./spaces-files/client
COPY spaces-files/web ./spaces-files/web
# phi-spaces as the checkout links it (file:../spaces); /srv/files holds the three directories, each mode 700
RUN mkdir -p spaces-files/node_modules && ln -s ../../spaces spaces-files/node_modules/phi-spaces \
 && mkdir -p /srv/files && chown node:node /srv/files && chmod 700 /srv/files
COPY --from=rust-builder /opt/phi-spaces/spaces-files/rust/target/release/files-space /usr/local/bin/files-space
USER node
WORKDIR /opt/phi-spaces/spaces-files
CMD ["node", "--no-warnings", "--experimental-strip-types", "server/launch.ts"]
