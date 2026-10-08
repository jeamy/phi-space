#!/usr/bin/env bash
# Remote docker test bed for pi-spaces: syncs this checkout to a server over ssh and runs the tests, and later the
# federation hosts, in docker containers there instead of on the developer machine.
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
  sync                           copy this checkout (including uncommitted changes) to <dir>/repo
  up [core|federation]           init + sync + build + start every container that is not running (default: core)
  status                         containers of the test bed
  test [quick|unit|examples|typecheck|all] [-- args]
                                 run in the runner container (default: quick = typecheck + unit);
                                 args after -- go to the test command of a single suite
  scenario <name> [args]         sync, start the runner and run test/testbed/scenarios/<name>.ts in it
                                 (sieve-mobile create|run|evaluate|all: simulated phone, see docs/testumgebung-big.md)
  exec <service> <command...>    run a command in a running container (tty if available)
  logs <service> [lines]         last log lines of a container (default 200)
  stop <service>                 stop one container; it stays down until `up`
  kill <service>                 SIGKILL then start again, like a crash and reboot; the volume survives
  partition <service>            disconnect from the test network
  heal <service>                 reconnect to the test network
  down                           remove containers and network, keep volumes and the repo copy
  destroy --yes                  down + remove volumes and the image (the directory and repo copy stay)
  config                         show the effective settings

Settings (environment or test/testbed/testbed.env), defaults in brackets:
  TESTBED_SSH_TARGET [big]  TESTBED_SSH_USER  TESTBED_SSH_PORT  TESTBED_SSH_KEY  TESTBED_SSH_OPTS
  TESTBED_SSH_PASSWORD (needs sshpass; a key is preferred)  TESTBED_SSH_BATCH [1]
  TESTBED_REMOTE_DIR [/media/docker/pi-spaces]  TESTBED_SUDO [no|yes]  TESTBED_DOCKER_HOST (rootless socket, autodetected)
  TESTBED_PROJECT [pi-spaces-test]  TESTBED_NODE_IMAGE [node:22-bookworm-slim]
  TESTBED_MEM_LIMIT [512m] TESTBED_CPUS [0.5] TESTBED_RUNNER_MEM [2g] TESTBED_RUNNER_CPUS [2.0] TESTBED_PIDS_LIMIT [1024]
  (limits apply per container; 0 switches a limit off)
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

TEMPLATES=("docker-compose.yml:compose.yml:644" "Dockerfile:Dockerfile:644" "entrypoint.sh:entrypoint.sh:755" ".dockerignore:dockerignore:644")

cmd_init() {
	local force=0
	[[ ${1:-} == --force ]] && force=1
	ensure_connection
	info "directory $DIR on $TARGET"
	r "mkdir -p $(shq "$DIR/repo")"
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

EXCLUDES=(--exclude .git/ --exclude node_modules --exclude dist/ --exclude '*.log' --exclude '*.tsbuildinfo'
	--exclude .env --exclude .DS_Store --exclude test/testbed/testbed.env)

cmd_sync() {
	ensure_connection
	r "mkdir -p $(shq "$DIR/repo")"
	local ssh_cmd="ssh" a rsh=()
	for a in "${SSH_ARGS[@]}"; do ssh_cmd+=" $a"; done
	resolve_sudo
	[[ -n $SUDO_PREFIX ]] && rsh=(--rsync-path "sudo -n rsync")
	info "sync $REPO -> $TARGET:$DIR/repo"
	local cmd=("${AUTH[@]+"${AUTH[@]}"}" rsync -az --delete --no-owner --no-group --human-readable --info=stats1
		"${rsh[@]+"${rsh[@]}"}" -e "$ssh_cmd" "${EXCLUDES[@]}" "$REPO/" "$TARGET:$DIR/repo/")
	if dry; then printf '[dry-run] %s\n' "${cmd[*]}" >&2; return 0; fi
	local out
	out=$("${cmd[@]}") || die "rsync failed"
	grep -E "Number of (regular )?files|Total transferred|Total file size" <<<"$out" >&2 || true
}

cmd_up() {
	# Always with every profile enabled: containers of services in an inactive profile must not look like orphans, or
	# `up core` (which `test` runs) would remove the federation containers.
	local profile=${1:-core} svcs=()
	case $profile in
		core) svcs=(runner) ;;
		federation | all) ;;
		*) die "up: unknown profile '$profile' (core, federation)" ;;
	esac
	cmd_init
	cmd_sync
	info "build image (cached unless package*.json or the Dockerfile changed)"
	rcompose build --quiet runner >/dev/null || die "image build failed (on the server: cd $DIR && docker compose build runner)"
	info "start containers that are not running ($profile)"
	rcompose --profile '*' up -d --remove-orphans "${svcs[@]+"${svcs[@]}"}"
	cmd_status
}

cmd_status() {
	ensure_connection
	rcompose --profile '*' ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Image}}'
}

cmd_test() {
	local suite=${1:-quick}
	[[ $# -gt 0 ]] && shift
	[[ ${1:-} == -- ]] && shift
	local extra=("$@") steps=()
	case $suite in
		quick) steps=(typecheck unit) ;;
		unit | examples | typecheck) steps=("$suite") ;;
		all) steps=(typecheck unit examples) ;;
		*) die "test: unknown suite '$suite' (quick, unit, examples, typecheck, all)" ;;
	esac
	[[ ${#extra[@]} -gt 0 && ${#steps[@]} -gt 1 ]] && die "test: extra arguments only work with a single suite"
	cmd_up core
	local step c failed=()
	for step in "${steps[@]}"; do
		case $step in
			typecheck) c="npm run typecheck" ;;
			unit) c="npm test" ;;
			examples) c="npm run test:examples" ;;
		esac
		[[ ${#extra[@]} -gt 0 && $step != typecheck ]] && c+=" -- $(shq_join "${extra[@]}")"
		info "$step: $c"
		if ! rcompose exec -T runner sh -c "cd /work && $c"; then failed+=("$step"); fi
	done
	if [[ ${#failed[@]} -gt 0 ]]; then die "failed: ${failed[*]}"; fi
	if dry; then info "dry run: nothing was executed"; else info "all passed: ${steps[*]}"; fi
}

cmd_scenario() {
	local name=${1:-}
	[[ $name =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "scenario: a name is expected; available: $(cd "$HERE/scenarios" && ls | sed 's/\.ts$//' | tr '\n' ' ')"
	[[ -f $HERE/scenarios/$name.ts ]] || die "scenario: unknown '$name'; available: $(cd "$HERE/scenarios" && ls | sed 's/\.ts$//' | tr '\n' ' ')"
	shift
	cmd_up core
	info "scenario $name $*"
	# The exit code of the scenario is the exit code of this command (0 passed, 1 failed, 2 usage).
	rcompose exec -T runner sh -c "cd /work && node --no-warnings --experimental-strip-types test/testbed/scenarios/$name.ts $(shq_join "$@")"
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
	info "removed. $DIR and $DIR/repo are untouched; delete them by hand if wanted."
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
		sync) cmd_sync ;;
		up) cmd_up "$@" ;;
		status) cmd_status ;;
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
		*) die "unknown command '$cmd' (see --help)" ;;
	esac
}
main "$@"
