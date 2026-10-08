#!/bin/sh
# node_modules is installed in the image, not synced: make it visible to the bind-mounted sources.
if [ -d /work ] && [ "$(readlink /work/node_modules 2>/dev/null)" != /opt/deps/node_modules ]; then
	ln -sfn /opt/deps/node_modules /work/node_modules 2>/dev/null || echo "testbed: could not link /work/node_modules" >&2
fi
exec "$@"
