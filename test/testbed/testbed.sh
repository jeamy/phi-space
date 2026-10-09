#!/usr/bin/env bash
# Remote docker test bed for pi-spaces: builds the production artifacts here (the pi-spaces.mjs bundle, compiled
# examples and scenarios), ships ONLY those to a server over ssh, builds a production-like image from them there and
# runs scenarios, and later the federation hosts, in docker containers. No source code reaches the server.
# Docs: docs/testumgebung-big.md (German), test/testbed/README.md. Usage: testbed.sh --help
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
ENV_FILE=${TESTBED_ENV_FILE:-$HERE/testbed.env}
DRY_RUN=${TESTBED_DRY_RUN:-0}

die() { printf 'testbed: %s\n' "$*" >&2; exit 1; }
warn() { printf 'testbed: warning: %s\n' "$*" >&2; }
info() { printf '==> %s\n' "$*" >&2; }
dry() { [[ $DRY_RUN == 1 ]]; }

usage() {
	cat <<'EOF'
Usage: testbed.sh [options] <command> [args]

Options:
  -n, --dry-run        print what would run on the server, change nothing
      --env-file FILE  settings file (default: test/testbed/testbed.env); environment variables win
  -h, --help

Commands:
  check                          read-only: local tools, ssh, sudo, docker, compose, rsync, directory
  init [--force]                 create the server directory and the compose files; existing files are kept
  build                          build the artifacts locally (dist/testbed-artifacts); nothing is sent
  ship                           build, then copy the artifacts (and nothing else) to <dir>/build on the server
  up [core|federation|overlay|all]
                                 init + ship + image build + reconcile/start containers (may recreate; default: core);
                                 overlay = NetBird agent peers (needs `netbird setup` first)
  status                         containers of the test bed
  inspect <service>             read-only committed spaces and scenario reports (JSON; no build/start)
  start <service>               start an existing stopped container (no build/ship)
  test [smoke|examples|scenario|all]
                                 production checks in the runner container (default: all): the shipped bundle loads,
                                 no sources on the server, the compiled examples run, the sieve-mobile scenario passes
  scenario <name> [args]         ship, start the runner and run the compiled scenarios/<name>.mjs in it
                                 (sieve-mobile create|run|evaluate|all: simulated phone, see docs/testumgebung-big.md)
  purge-sources                  remove a leftover source copy (<dir>/repo) from earlier versions of this script
  exec <service> <command...>    run a command in a running container (tty if available)
  logs <service> [lines]         last log lines of a container (default 200)
  stop <service>                 stop one container; it stays down until `up`
  kill <service>                 SIGKILL then start again, like a crash and reboot; the volume survives
  partition <service>            disconnect from the test network
  heal <service>                 reconnect to the test network
  down                           remove containers and network, keep volumes and the shipped artifacts
  destroy --yes                  down + remove volumes and the image (the directory and <dir>/build stay)
  netbird <init|up|setup|status|down|logs|nginx [bootstrap]|destroy --yes>
                                 NetBird management stack (own compose project in <dir>/netbird, docs/testumgebung-big.md);
                                 `nginx` prints the site for the host's nginx (root installs it, the script never does)
  config                         show the effective settings

Settings (environment or test/testbed/testbed.env), defaults in brackets:
  TESTBED_SSH_TARGET [big]  TESTBED_SSH_USER  TESTBED_SSH_PORT  TESTBED_SSH_KEY  TESTBED_SSH_OPTS
  TESTBED_SSH_PASSWORD (needs sshpass; a key is preferred)  TESTBED_SSH_BATCH [1]
  TESTBED_REMOTE_DIR [/media/docker/pi-spaces]  TESTBED_SUDO [no|yes]  TESTBED_DOCKER_HOST (rootless socket, autodetected)
  TESTBED_PROJECT [pi-spaces-test]  TESTBED_NODE_IMAGE [node:22-bookworm-slim]
  TESTBED_MEM_LIMIT [512m] TESTBED_CPUS [0.5] TESTBED_RUNNER_MEM [2g] TESTBED_RUNNER_CPUS [2.0] TESTBED_PIDS_LIMIT [1024]
  (limits apply per container; 0 switches a limit off)
  TESTBED_NETBIRD_DOMAIN [spacebird.eibrain.org]  TESTBED_NETBIRD_PROJECT [spacebird]
  TESTBED_NETBIRD_DASHBOARD_PORT [18080]  TESTBED_NETBIRD_SERVER_PORT [18081]  (loopback ports behind nginx)
  TESTBED_NETBIRD_SPACE_PORT [7421]  (TCP port the policies allow between the space groups; placeholder until space-gate)
  TESTBED_NETBIRD_STUN_BIND [127.0.0.1]  (0.0.0.0 publishes STUN on UDP 3478 for peers outside the host)
  TESTBED_NETBIRD_VERSION [0.80.0]  TESTBED_NETBIRD_DASHBOARD_VERSION [latest]  (image tags; the dashboard has its own versioning)
EOF
}

# ---------------------------------------------------------------- settings

# Read KEY=VALUE lines for TESTBED_* keys without executing the file; variables already set in the environment win.
load_env_file() {
	local f=$1 line key val
	[[ -f $f ]] || return 0
	while IFS= read -r line || [[ -n $line ]]; do
		[[ $line =~ ^[[:space:]]*(#|$) ]] && continue
		if [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?(TESTBED_[A-Z_]+)=(.*)$ ]]; then
			key=${BASH_REMATCH[2]}
			val=${BASH_REMATCH[3]}
			val=${val%"${val##*[![:space:]]}"} # trailing blanks
			if [[ $val =~ ^\"(.*)\"$ || $val =~ ^\'(.*)\'$ ]]; then val=${BASH_REMATCH[1]}; fi
			[[ -z ${!key+x} ]] && export "$key=$val"
		else
			warn "ignoring line in $f: ${line%%=*}"
		fi
	done <"$f"
	return 0
}

configure() {
	load_env_file "$ENV_FILE"
	: "${TESTBED_SSH_TARGET:=big}"
	: "${TESTBED_REMOTE_DIR:=/media/docker/pi-spaces}"
	: "${TESTBED_SUDO:=no}"
	: "${TESTBED_SSH_BATCH:=1}"
	: "${TESTBED_PROJECT:=pi-spaces-test}"
	: "${TESTBED_NODE_IMAGE:=node:22-bookworm-slim}"
	: "${TESTBED_MEM_LIMIT:=512m}" "${TESTBED_CPUS:=0.5}" "${TESTBED_RUNNER_MEM:=2g}" "${TESTBED_RUNNER_CPUS:=2.0}" "${TESTBED_PIDS_LIMIT:=1024}"
	: "${TESTBED_NETBIRD_DOMAIN:=spacebird.eibrain.org}" "${TESTBED_NETBIRD_PROJECT:=spacebird}"
	: "${TESTBED_NETBIRD_DASHBOARD_PORT:=18080}" "${TESTBED_NETBIRD_SERVER_PORT:=18081}"
	: "${TESTBED_NETBIRD_STUN_BIND:=127.0.0.1}" "${TESTBED_NETBIRD_SPACE_PORT:=7421}" "${TESTBED_NETBIRD_VERSION:=0.80.0}" "${TESTBED_NETBIRD_DASHBOARD_VERSION:=latest}"
	[[ $TESTBED_NETBIRD_DOMAIN =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "TESTBED_NETBIRD_DOMAIN: a host name"
	[[ $TESTBED_NETBIRD_PROJECT =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "TESTBED_NETBIRD_PROJECT: lower case letters, digits, - and _"
	[[ $TESTBED_NETBIRD_DASHBOARD_PORT =~ ^[0-9]{4,5}$ && $TESTBED_NETBIRD_SERVER_PORT =~ ^[0-9]{4,5}$ ]] || die "TESTBED_NETBIRD_*_PORT: unprivileged port numbers"
	[[ $TESTBED_NETBIRD_SPACE_PORT =~ ^[0-9]{2,5}$ ]] || die "TESTBED_NETBIRD_SPACE_PORT: a port number"
	[[ $TESTBED_NETBIRD_STUN_BIND =~ ^[0-9.]+$ ]] || die "TESTBED_NETBIRD_STUN_BIND: an IPv4 address"
	[[ $TESTBED_NETBIRD_VERSION =~ ^[A-Za-z0-9._-]+$ && $TESTBED_NETBIRD_DASHBOARD_VERSION =~ ^[A-Za-z0-9._-]+$ ]] || die "TESTBED_NETBIRD_VERSION / _DASHBOARD_VERSION: an image tag"
	TARGET=$TESTBED_SSH_TARGET
	DIR=${TESTBED_REMOTE_DIR%/}
	PROJECT=$TESTBED_PROJECT
	[[ $TARGET =~ ^[A-Za-z0-9][A-Za-z0-9._@:-]*$ ]] || die "TESTBED_SSH_TARGET: not a host name, alias or user@host"
	[[ $DIR =~ ^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$ ]] || die "TESTBED_REMOTE_DIR must be an absolute path of at least two components [A-Za-z0-9._-]"
	[[ $PROJECT =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "TESTBED_PROJECT: lower case letters, digits, - and _"
	[[ $TESTBED_SUDO =~ ^(yes|no)$ ]] || die "TESTBED_SUDO must be no or yes"
	[[ -z ${TESTBED_DOCKER_HOST:-} || $TESTBED_DOCKER_HOST =~ ^(unix|tcp|ssh)://[A-Za-z0-9._:/@-]+$ ]] || die "TESTBED_DOCKER_HOST: unix://... expected"
	[[ $TESTBED_PIDS_LIMIT =~ ^-?[0-9]+$ ]] || die "TESTBED_PIDS_LIMIT: a number"
	[[ $TESTBED_NODE_IMAGE =~ ^[A-Za-z0-9._/:@-]+$ ]] || die "TESTBED_NODE_IMAGE: not an image name"
	local v
	for v in "$TESTBED_MEM_LIMIT" "$TESTBED_RUNNER_MEM"; do [[ $v =~ ^[0-9]+[kmgKMG]?$ ]] || die "memory limit '$v' (e.g. 1g)"; done
	for v in "$TESTBED_CPUS" "$TESTBED_RUNNER_CPUS"; do [[ $v =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "cpu limit '$v' (e.g. 1.0)"; done

	SSH_ARGS=(-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ControlMaster=auto -o ControlPersist=120
		-o "ControlPath=${TMPDIR:-/tmp}/pi-spaces-testbed-%C")
	[[ -n ${TESTBED_SSH_USER:-} ]] && SSH_ARGS+=(-l "$TESTBED_SSH_USER")
	[[ -n ${TESTBED_SSH_PORT:-} ]] && SSH_ARGS+=(-p "$TESTBED_SSH_PORT")
	[[ -n ${TESTBED_SSH_KEY:-} ]] && SSH_ARGS+=(-i "$TESTBED_SSH_KEY" -o IdentitiesOnly=yes)
	AUTH=()
	if [[ -n ${TESTBED_SSH_PASSWORD:-} ]]; then
		command -v sshpass >/dev/null || die "TESTBED_SSH_PASSWORD needs sshpass (or use a key)"
		export SSHPASS=$TESTBED_SSH_PASSWORD
		AUTH=(sshpass -e)
	elif [[ $TESTBED_SSH_BATCH == 1 ]]; then
		SSH_ARGS+=(-o BatchMode=yes)
	fi
	# shellcheck disable=SC2206 # deliberate word splitting of extra options
	[[ -n ${TESTBED_SSH_OPTS:-} ]] && SSH_ARGS+=($TESTBED_SSH_OPTS)
	return 0
}

cmd_config() {
	cat <<EOF
ssh target      $TARGET${TESTBED_SSH_USER:+ (user $TESTBED_SSH_USER)}${TESTBED_SSH_PORT:+ port $TESTBED_SSH_PORT}${TESTBED_SSH_KEY:+ key $TESTBED_SSH_KEY}
password        $([[ -n ${TESTBED_SSH_PASSWORD:-} ]] && echo "set (sshpass)" || echo "not used")
remote dir      $DIR
sudo            $TESTBED_SUDO
docker host     ${TESTBED_DOCKER_HOST:-autodetect}
compose project $PROJECT
node image      $TESTBED_NODE_IMAGE
limits          runner $TESTBED_RUNNER_MEM / $TESTBED_RUNNER_CPUS cpus, hosts $TESTBED_MEM_LIMIT / $TESTBED_CPUS cpus, $TESTBED_PIDS_LIMIT pids
settings file   $ENV_FILE$([[ -f $ENV_FILE ]] || echo " (absent)")
dry run         $DRY_RUN
EOF
}

# ---------------------------------------------------------------- remote execution

# Single-quote a word for a POSIX shell (works for any remote login shell).
shq() { local q="'\\''" s=$1; printf "'%s'" "${s//\'/$q}"; }
shq_join() { local a out=""; for a in "$@"; do out+="${out:+ }$(shq "$a")"; done; printf '%s' "$out"; }

ssh_run() { "${AUTH[@]+"${AUTH[@]}"}" ssh "${SSH_ARGS[@]}" "$@"; }

SUDO_PREFIX=""
SUDO_RESOLVED=0
resolve_sudo() {
	[[ $SUDO_RESOLVED == 1 ]] && return 0
	[[ $TESTBED_SUDO == yes ]] && SUDO_PREFIX="sudo -n "
	SUDO_RESOLVED=1
}

# Docker on the test server is rootless (one daemon per user). Non-login sessions may not know where the socket is:
# use TESTBED_DOCKER_HOST, else the user's rootless socket when there is no system socket.
docker_env() {
	if [[ -n ${TESTBED_DOCKER_HOST:-} ]]; then printf 'export DOCKER_HOST=%s; ' "$(shq "$TESTBED_DOCKER_HOST")"
	else printf '%s' 'if [ -z "$DOCKER_HOST" ] && [ ! -S /var/run/docker.sock ] && [ -S "/run/user/$(id -u)/docker.sock" ]; then export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"; fi; '; fi
}
wrap() { printf '%ssh -c %s' "$SUDO_PREFIX" "$(shq "$(docker_env)$1")"; }

# r <script>: run a shell snippet on the server as the ssh user (or through sudo -n with TESTBED_SUDO=yes).
r() {
	resolve_sudo
	if dry; then printf '[dry-run] %s: %s\n' "$TARGET" "$1" >&2; return 0; fi
	ssh_run "$TARGET" "$(wrap "$1")" </dev/null
}
# rt: like r, with a terminal when there is one (interactive exec)
rt() {
	resolve_sudo
	if dry; then printf '[dry-run] %s: %s\n' "$TARGET" "$1" >&2; return 0; fi
	if [[ -t 0 && -t 1 ]]; then ssh_run -t "$TARGET" "$(wrap "$1")"; else ssh_run "$TARGET" "$(wrap "$1")" </dev/null; fi
}
# put <local file> <remote path> <mode>: write a file on the server atomically
put() {
	resolve_sudo
	if dry; then printf '[dry-run] %s: write %s (%s)\n' "$TARGET" "$2" "$3" >&2; return 0; fi
	ssh_run "$TARGET" "$(wrap "umask 022; cat > $(shq "$2.tmp") && chmod $3 $(shq "$2.tmp") && mv $(shq "$2.tmp") $(shq "$2")")" <"$1"
}
rcompose() { r "cd $(shq "$DIR") && docker compose $(shq_join "$@")"; }
rcompose_t() { rt "cd $(shq "$DIR") && docker compose $(shq_join "$@")"; }

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
remote_sha() { r "sha256sum $(shq "$1") 2>/dev/null | cut -d' ' -f1" || true; }

need_local() { local t; for t in "$@"; do command -v "$t" >/dev/null || die "$t is not installed on this machine"; done; }

ensure_connection() {
	need_local ssh rsync
	dry && return 0
	r true || die "cannot run commands on $TARGET (ssh/sudo); run: testbed.sh check"
}

# ---------------------------------------------------------------- commands

cmd_check() {
	local bad=0
	info "local tools"
	local t
	for t in ssh rsync; do if command -v "$t" >/dev/null; then echo "  $t: ok"; else echo "  $t: MISSING"; bad=1; fi; done
	cmd_config | sed 's/^/  /'
	info "server $TARGET"
	if ! dry && ! ssh_run "$TARGET" true </dev/null 2>/dev/null; then
		echo "  ssh: FAILED (check TESTBED_SSH_* and ~/.ssh/config; password logins need TESTBED_SSH_BATCH=0 or sshpass)"
		return 1
	fi
	resolve_sudo
	r 'echo "  login/user: $(id -un) (uid $(id -u)) on $(hostname), $(uname -m), $(uname -sr)"' || bad=1
	if [[ -n $SUDO_PREFIX ]]; then echo "  sudo: commands run through 'sudo -n'"; fi
	r 'if v=$(docker version --format "{{.Server.Version}}" 2>/dev/null); then echo "  docker: $v ($(docker info --format "{{.SecurityOptions}} cgroup v{{.CgroupVersion}}, {{.NCPU}} cpus, {{.MemTotal}} bytes" 2>/dev/null))"; echo "  docker host: ${DOCKER_HOST:-default}"; echo "  containers running: $(docker ps -q | wc -l)"; else echo "  docker: NOT REACHABLE for $(id -un) (daemon down, or rootless socket elsewhere: set TESTBED_DOCKER_HOST, or ssh as the user who owns the daemon)"; exit 1; fi' || bad=1
	r 'if v=$(docker compose version --short 2>/dev/null); then echo "  docker compose: $v"; else echo "  docker compose: MISSING (the v2 plugin is required)"; exit 1; fi' || bad=1
	r 'if command -v rsync >/dev/null; then echo "  rsync: ok"; else echo "  rsync: MISSING on the server (install it; sync needs it)"; exit 1; fi' || bad=1
	r "if [ -d $(shq "$DIR") ]; then echo '  directory: exists'; df -h $(shq "$DIR") | tail -1 | sed 's/^/  disk: /'; ls -A $(shq "$DIR") | sed 's/^/    /'; else echo '  directory: absent (init creates it)'; df -h $(shq "$(dirname "$DIR")") 2>/dev/null | tail -1 | sed 's/^/  disk of parent: /'; fi" || bad=1
	r "docker ps -a --filter label=com.docker.compose.project=$PROJECT --format '  container: {{.Names}} {{.Status}}'" || true
	[[ $bad == 0 ]] && info "check passed" || { warn "check found problems"; return 1; }
}

env_content() {
	cat <<EOF
# Generated by test/testbed/testbed.sh init on $(date -u +%Y-%m-%dT%H:%M:%SZ). Read by docker compose.
# Never overwritten by the script; edit freely. Contains no credentials.
TESTBED_PROJECT=$PROJECT
TESTBED_NODE_IMAGE=$TESTBED_NODE_IMAGE
TESTBED_MEM_LIMIT=$TESTBED_MEM_LIMIT
TESTBED_CPUS=$TESTBED_CPUS
TESTBED_RUNNER_MEM=$TESTBED_RUNNER_MEM
TESTBED_RUNNER_CPUS=$TESTBED_RUNNER_CPUS
TESTBED_PIDS_LIMIT=$TESTBED_PIDS_LIMIT
EOF
}

TEMPLATES=("docker-compose.yml:compose.yml:644" "Dockerfile:Dockerfile:644" ".dockerignore:dockerignore:644")

cmd_init() {
	local force=0
	[[ ${1:-} == --force ]] && force=1
	ensure_connection
	info "directory $DIR on $TARGET"
	r "mkdir -p $(shq "$DIR/build")"
	local spec name rest src mode want have
	for spec in "${TEMPLATES[@]}"; do
		name=${spec%%:*}; rest=${spec#*:}; src=${rest%%:*}; mode=${rest##*:}
		want=$(sha256 "$HERE/docker/$src")
		have=$(remote_sha "$DIR/$name")
		if [[ -z $have ]]; then
			put "$HERE/docker/$src" "$DIR/$name" "$mode"; info "created $name"
		elif [[ $have != "$want" ]]; then
			if [[ $force == 1 ]]; then put "$HERE/docker/$src" "$DIR/$name" "$mode"; info "updated $name"
			else warn "$name on the server differs from the template; kept (init --force overwrites)"; fi
		fi
	done
	if dry || ! r "test -f $(shq "$DIR/.env")"; then
		env_content >"${TMPDIR:-/tmp}/testbed-env.$$"
		put "${TMPDIR:-/tmp}/testbed-env.$$" "$DIR/.env" 644
		rm -f "${TMPDIR:-/tmp}/testbed-env.$$"
		info "created .env"
	fi
}

ARTIFACTS="$REPO/dist/testbed-artifacts"

cmd_build() {
	need_local node
	[[ -f $REPO/node_modules/esbuild/package.json ]] || die "esbuild is not installed in $REPO/node_modules (npm install)"
	info "build artifacts"
	node "$HERE/build-artifacts.mjs" "$ARTIFACTS" >&2
}

# Ship only the built artifacts: a few .mjs files and the dependency manifests, never TypeScript sources.
cmd_ship() {
	ensure_connection
	cmd_build
	if find "$ARTIFACTS" -type f \( -name '*.ts' -o -name '*.tsx' \) | grep -q .; then die "TypeScript source found in $ARTIFACTS; refusing to ship"; fi
	r "mkdir -p $(shq "$DIR/build")"
	local ssh_cmd="ssh" a rsh=()
	for a in "${SSH_ARGS[@]}"; do ssh_cmd+=" $a"; done
	resolve_sudo
	[[ -n $SUDO_PREFIX ]] && rsh=(--rsync-path "sudo -n rsync")
	info "ship artifacts -> $TARGET:$DIR/build"
	local cmd=("${AUTH[@]+"${AUTH[@]}"}" rsync -az --delete --checksum --no-owner --no-group --human-readable --info=stats1
		"${rsh[@]+"${rsh[@]}"}" -e "$ssh_cmd" "$ARTIFACTS/" "$TARGET:$DIR/build/")
	if dry; then printf '[dry-run] %s\n' "${cmd[*]}" >&2; return 0; fi
	local out
	out=$("${cmd[@]}") || die "rsync failed"
	grep -E "Number of (regular )?files|Total transferred|Total file size" <<<"$out" >&2 || true
}

cmd_purge_sources() {
	ensure_connection
	r "if [ -d $(shq "$DIR/repo") ]; then n=\$(find $(shq "$DIR/repo") -type f | wc -l); rm -rf -- $(shq "$DIR/repo"); echo \"removed $DIR/repo (\$n files)\"; else echo 'no source copy on the server'; fi; rm -f -- $(shq "$DIR/entrypoint.sh")"
}

cmd_up() {
	# Always with every profile enabled: containers of services in an inactive profile must not look like orphans, or
	# `up core` (which `test` runs) would remove the federation containers.
	local profile=${1:-core} svcs=()
	case $profile in
		core) svcs=(runner) ;;
		federation) svcs=(runner nb-host-a nb-host-b nb-member-1 nb-member-2 host-a host-b member-1 member-2) ;;
		overlay) svcs=(nb-host-a nb-host-b nb-member-1 nb-member-2) ;;
		all) ;;
		*) die "up: unknown profile '$profile' (core, federation, overlay, all)" ;;
	esac
	cmd_init
	cmd_ship
	info "build image (production dependencies cached unless the manifests change)"
	rcompose build --quiet runner >/dev/null || die "image build failed (on the server: cd $DIR && docker compose build runner)"
	info "reconcile/start containers ($profile; changed image/config may recreate them)"
	rcompose --profile '*' up -d --remove-orphans "${svcs[@]+"${svcs[@]}"}"
	cmd_status
}

cmd_status() {
	ensure_connection
	rcompose --profile '*' ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Image}}'
}

# JS run inside the container by `test smoke`: the shipped bundle loads and exports what the runtime uses.
SMOKE_JS="$(cat <<'JS'
import * as m from '/opt/app/pi-spaces.mjs';
import { readFileSync } from 'node:fs';
const need = ['PiSpaces', 'createSpace', 'listSpaces', 'claims', 'startService', 'spaces', 'FOREVER'];
const missing = need.filter((k) => !(k in m));
const man = JSON.parse(readFileSync('/opt/app/MANIFEST.json', 'utf8'));
console.log(`node ${process.version}, NODE_ENV=${process.env.NODE_ENV}, uid ${process.getuid()}, artifact ${man.commit}${man.dirty ? ' (uncommitted changes)' : ''} built ${man.builtAt}`);
if (missing.length) { console.error('missing exports: ' + missing.join(', ')); process.exit(1); }
JS
)"

FAILED=()
check_step() {
	local label=$1
	shift
	info "$label"
	if ! "$@"; then FAILED+=("$label"); warn "FAILED: $label"; fi
}
in_runner() { rcompose exec -T runner "$@"; }

test_smoke() {
	in_runner node --input-type=module -e "$SMOKE_JS" || return 1
	# No sources anywhere: not in the image, not on the host.
	in_runner sh -c 'n=$(find /opt/app -path /opt/app/node_modules -prune -o -type f \( -name "*.ts" -o -name "*.tsx" \) -print | wc -l); echo "TypeScript files in the image outside node_modules: $n"; test "$n" = 0' || return 1
	dry && return 0
	r "n=\$(find $(shq "$DIR") -type f \\( -name '*.ts' -o -name '*.tsx' \\) | wc -l); echo \"TypeScript files on the server under $DIR: \$n\"; test \"\$n\" = 0; test ! -e $(shq "$DIR/repo")"
}
test_examples() {
	local out bad=0 spec name
	for spec in "workers" "sensor-pipeline" "chat" "cache" "sieve 1001 2"; do
		# shellcheck disable=SC2086 # deliberate splitting: name and arguments
		set -- $spec
		name=$1
		shift
		if out=$(in_runner node "examples/$name.mjs" "$@" 2>&1); then
			if [[ $name == sieve && ! $out =~ "168 primes" ]]; then echo "  FAIL  examples/$name.mjs: no '168 primes' in the output"; bad=1; else echo "  ok    examples/$name.mjs $*"; fi
		else echo "  FAIL  examples/$name.mjs $*"; printf '%s\n' "$out" | tail -5 | sed 's/^/        /'; bad=1; fi
	done
	return $bad
}
test_scenario() { in_runner node scenarios/sieve-mobile.mjs all && in_runner node scenarios/sieve-remote.mjs all --kill-host --fresh; }

cmd_test() {
	local suite=${1:-all} steps=()
	case $suite in
		smoke | examples | scenario) steps=("$suite") ;;
		all) steps=(smoke examples scenario) ;;
		*) die "test: unknown suite '$suite' (smoke, examples, scenario, all)" ;;
	esac
	cmd_up core
	local step
	for step in "${steps[@]}"; do check_step "$step" "test_$step"; done
	if [[ ${#FAILED[@]} -gt 0 ]]; then die "failed: ${FAILED[*]}"; fi
	if dry; then info "dry run: nothing was executed"; else info "all passed: ${steps[*]}"; fi
}

cmd_scenario() {
	local name=${1:-} avail
	avail=$(cd "$HERE/scenarios" && ls | sed 's/\.ts$//' | tr '\n' ' ')
	[[ $name =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "scenario: a name is expected; available: $avail"
	[[ -f $HERE/scenarios/$name.ts ]] || die "scenario: unknown '$name'; available: $avail"
	shift
	cmd_up core
	info "scenario $name $*"
	# The exit code of the scenario is the exit code of this command (0 passed, 1 failed, 2 usage).
	rcompose exec -T runner node "scenarios/$name.mjs" "$@"
}

valid_service() { [[ ${1:-} =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "service name expected (runner, host-a, ...)"; }

cmd_exec() {
	valid_service "${1:-}"
	local svc=$1
	shift
	[[ $# -gt 0 ]] || die "exec: command expected"
	ensure_connection
	if [[ -t 0 && -t 1 ]]; then rcompose_t --profile '*' exec "$svc" "$@"; else rcompose --profile '*' exec -T "$svc" "$@"; fi
}

cmd_logs() { valid_service "${1:-}"; ensure_connection; rcompose --profile '*' logs --no-color --tail "${2:-200}" "$1"; }
cmd_start() { valid_service "${1:-}"; ensure_connection; rcompose --profile '*' start "$1"; }
cmd_inspect() {
	valid_service "${1:-}"
	[[ $# == 1 ]] || die "inspect: exactly one service expected"
	ensure_connection
	rcompose --profile '*' exec -T "$1" sh -c 'test -f tools/inspect.mjs || { echo "Inspection artifact missing: update the Dockerfile template (init --force) and deploy with up core." >&2; exit 1; }; exec node --no-warnings tools/inspect.mjs /data'
}
cmd_stop() { valid_service "${1:-}"; ensure_connection; rcompose --profile '*' stop "$1"; }
# SIGKILL, then an explicit start: a crash plus reboot, whatever the restart policy does with a killed container.
cmd_kill() { valid_service "${1:-}"; ensure_connection; rcompose --profile '*' kill -s KILL "$1"; rcompose --profile '*' start "$1"; }

container_of() {
	local id
	id=$(r "cd $(shq "$DIR") && docker compose --profile '*' ps -q $(shq "$1")" | head -n1)
	[[ -n $id || $DRY_RUN == 1 ]] || die "$1 is not running"
	printf '%s' "${id:-<container>}"
}
cmd_partition() { valid_service "${1:-}"; ensure_connection; r "docker network disconnect $(shq "${PROJECT}_testnet") $(shq "$(container_of "$1")")"; info "$1 is cut off from ${PROJECT}_testnet"; }
cmd_heal() { valid_service "${1:-}"; ensure_connection; r "docker network connect --alias $(shq "$1") $(shq "${PROJECT}_testnet") $(shq "$(container_of "$1")")"; info "$1 is back on ${PROJECT}_testnet"; }

cmd_down() { ensure_connection; rcompose --profile '*' down --remove-orphans; }
cmd_destroy() {
	[[ ${1:-} == --yes ]] || die "destroy removes containers, volumes (all test data) and the image; confirm with: destroy --yes"
	ensure_connection
	rcompose --profile '*' down --volumes --remove-orphans
	r "docker image rm $(shq "${PROJECT}-node:local") 2>/dev/null || true"
	info "removed. $DIR and $DIR/build are untouched; delete them by hand if wanted."
}

# ---------------------------------------------------------------- NetBird (own compose project, own directory)

NB_DIR() { printf '%s/netbird' "$DIR"; }
nb_compose() { r "cd $(shq "$(NB_DIR)") && docker compose $(shq_join "$@")"; }

# fill @NAME@ placeholders of a template into a local file
nb_render() {
	local src=$1 dst=$2
	sed -e "s|@DOMAIN@|$TESTBED_NETBIRD_DOMAIN|g" -e "s|@DASH_PORT@|$TESTBED_NETBIRD_DASHBOARD_PORT|g" \
		-e "s|@SERVER_PORT@|$TESTBED_NETBIRD_SERVER_PORT|g" "$src" >"$dst"
}

nb_env_content() {
	cat <<EOF
# Generated by testbed.sh netbird init on $(date -u +%Y-%m-%dT%H:%M:%SZ). Read by docker compose. Contains no credentials.
NETBIRD_PROJECT=$TESTBED_NETBIRD_PROJECT
NETBIRD_SERVER_IMAGE=netbirdio/netbird-server:$TESTBED_NETBIRD_VERSION
NETBIRD_DASHBOARD_IMAGE=netbirdio/dashboard:$TESTBED_NETBIRD_DASHBOARD_VERSION
NETBIRD_DASHBOARD_PORT=$TESTBED_NETBIRD_DASHBOARD_PORT
NETBIRD_SERVER_PORT=$TESTBED_NETBIRD_SERVER_PORT
NETBIRD_STUN_BIND=$TESTBED_NETBIRD_STUN_BIND
EOF
}

nb_init() {
	need_local openssl sed
	ensure_connection
	local nd tmp
	nd=$(NB_DIR)
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/testbed-nb.XXXXXX")
	info "NetBird directory $nd on $TARGET"
	r "mkdir -p $(shq "$nd")"
	if [[ $(remote_sha "$nd/docker-compose.yml") != "$(sha256 "$HERE/netbird/compose.yml")" ]]; then
		put "$HERE/netbird/compose.yml" "$nd/docker-compose.yml" 644; info "wrote docker-compose.yml"
	fi
	if dry || ! r "test -f $(shq "$nd/.env")"; then nb_env_content >"$tmp/env"; put "$tmp/env" "$nd/.env" 644; info "created .env"; fi
	if dry || ! r "test -f $(shq "$nd/dashboard.env")"; then
		nb_render "$HERE/netbird/dashboard.env.tmpl" "$tmp/dashboard.env"; put "$tmp/dashboard.env" "$nd/dashboard.env" 644; info "created dashboard.env"
	fi
	# config.yaml holds the generated secrets: created once with fresh keys, mode 600, never replaced or printed
	if dry || ! r "test -f $(shq "$nd/config.yaml")"; then
		nb_render "$HERE/netbird/config.yaml.tmpl" "$tmp/config.yaml"
		local relay cookie store
		relay=$(openssl rand -base64 32 | tr -d '=\n/+'); cookie=$(openssl rand -base64 32); store=$(openssl rand -base64 32)
		sed -i -e "s|@RELAY_SECRET@|$relay|" -e "s|@COOKIE_KEY@|$cookie|" -e "s|@STORE_KEY@|$store|" "$tmp/config.yaml"
		put "$tmp/config.yaml" "$nd/config.yaml" 600 # secrets; container root is the ssh user under rootless docker
		info "created config.yaml with new secrets (the store key cannot be recovered; keep it with the volume)"
	fi
	rm -rf "$tmp"
}

# nginx [bootstrap]: the site for the host's nginx. `bootstrap` is only the port-80 part (no certificate needed), so
# nginx -t passes and certbot can issue the certificate; then install the full site.
nb_nginx() {
	if [[ ${1:-} == bootstrap ]]; then
		nb_render "$HERE/netbird/nginx.conf.tmpl" /dev/stdout | awk '/^server \{/ { n++ } n < 2'
	else
		nb_render "$HERE/netbird/nginx.conf.tmpl" /dev/stdout
	fi
}

nb_status() {
	ensure_connection
	nb_compose ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
	r "docker image inspect --format '  {{index .RepoTags 0}} created {{.Created}} {{index .RepoDigests 0}}' netbirdio/netbird-server:$TESTBED_NETBIRD_VERSION netbirdio/dashboard:$TESTBED_NETBIRD_DASHBOARD_VERSION 2>/dev/null || true"
	if ! dry; then
		local code
		code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$TESTBED_NETBIRD_DOMAIN/api/instance" 2>/dev/null || true)
		echo "  public https://$TESTBED_NETBIRD_DOMAIN/api/instance -> HTTP ${code:-none} (200 = server reachable through nginx and TLS)"
	fi
}

# netbird setup [--rotate-keys]: groups, setup keys and policies through the management API. Runs on the server (the token in
# <dir>/netbird/secrets.env never leaves it and is never printed); idempotent. New setup keys are stored in secrets.env.
nb_setup() {
	local rotate=0
	[[ ${1:-} == --rotate-keys ]] && rotate=1
	ensure_connection
	local nd
	nd=$(NB_DIR)
	if ! dry && ! r "test -s $(shq "$nd/secrets.env")"; then
		die "netbird setup: $nd/secrets.env is missing. Create a service user (role Network Admin) in the dashboard, make a token for it and store it there: NB_PAT=<token>, mode 600"
	fi
	put "$HERE/netbird/setup.sh" "$nd/setup.sh" 700
	r "cd $(shq "$nd") && NB_URL=$(shq "https://$TESTBED_NETBIRD_DOMAIN") NB_SPACE_PORT=$(shq "$TESTBED_NETBIRD_SPACE_PORT") NB_ROTATE_KEYS=$rotate bash ./setup.sh"
}

cmd_netbird() {
	local sub=${1:-}
	[[ -n $sub ]] && shift
	case $sub in
		init) nb_init ;;
		up) nb_init; info "pull images and start (nginx and the certificate are the server administrator's job: netbird nginx)"
			nb_compose pull; nb_compose up -d --remove-orphans ;;
		setup) nb_setup "$@" ;;
		status) nb_status ;;
		logs) ensure_connection; nb_compose logs --no-color --tail "${1:-200}" ;;
		nginx) nb_nginx "$@" ;;
		down) ensure_connection; nb_compose down --remove-orphans ;;
		destroy) [[ ${1:-} == --yes ]] || die "netbird destroy removes the NetBird database (all peers and keys); run: netbird destroy --yes"
			ensure_connection; nb_compose down --volumes --remove-orphans
			info "volume removed; $(NB_DIR)/config.yaml (with the keys) stays, delete it by hand for a fresh start" ;;
		*) die "netbird: init | up | setup [--rotate-keys] | status | logs [n] | nginx [bootstrap] | down | destroy --yes" ;;
	esac
}

# ---------------------------------------------------------------- main

main() {
	local cmd=""
	while [[ $# -gt 0 ]]; do
		case $1 in
			-n | --dry-run) DRY_RUN=1; shift ;;
			--env-file) [[ $# -ge 2 ]] || die "--env-file needs a file"; ENV_FILE=$2; shift 2 ;;
			-h | --help) usage; exit 0 ;;
			-*) die "unknown option $1 (see --help)" ;;
			*) cmd=$1; shift; break ;;
		esac
	done
	[[ -n $cmd ]] || { usage; exit 2; }
	configure
	case $cmd in
		config) cmd_config ;;
		check) cmd_check ;;
		init) cmd_init "$@" ;;
		build) cmd_build ;;
		ship | sync) cmd_ship ;;
		purge-sources) cmd_purge_sources ;;
		up) cmd_up "$@" ;;
		status) cmd_status ;;
		inspect) cmd_inspect "$@" ;;
		start) cmd_start "$@" ;;
		test) cmd_test "$@" ;;
		scenario) cmd_scenario "$@" ;;
		exec) cmd_exec "$@" ;;
		logs) cmd_logs "$@" ;;
		stop) cmd_stop "$@" ;;
		kill) cmd_kill "$@" ;;
		partition) cmd_partition "$@" ;;
		heal) cmd_heal "$@" ;;
		down) cmd_down ;;
		destroy) cmd_destroy "$@" ;;
		netbird) cmd_netbird "$@" ;;
		*) die "unknown command '$cmd' (see --help)" ;;
	esac
}
main "$@"
