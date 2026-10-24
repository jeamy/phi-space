#!/usr/bin/env bash
# Runs ON THE SERVER (shipped over ssh by `testbed.sh netbird setup`): creates the groups, setup keys and policies of the test
# bed through the NetBird management API. Idempotent: existing objects are kept. Uses NB_PAT from secrets.env next to this
# script's working directory; the token is passed to curl through a config pipe and is never printed or put on a command line.
# Names follow docs/federation-plan-v3.md 4.1: groups space-hosts, space-admin, space-observer.
# Environment: NB_URL (https://...), NB_SPACE_PORT (TCP port of the space service, placeholder until space-gate exists),
#              NB_PRUNE_STALE=1 (delete disconnected peers whose name equals a connected peer's: left over from a re-enrolled container),
#              NB_ROTATE_KEYS=1 (create new setup keys even if the old ones exist; old ones are revoked).
set -euo pipefail
cd "$(dirname "$0")"
umask 077
: "${NB_URL:?NB_URL missing}" "${NB_SPACE_PORT:=7421}"
[[ -f secrets.env ]] || { echo "secrets.env missing (NB_PAT=<service user token>)" >&2; exit 1; }
# secrets.env is data, never sourced. A bare token line (as pasted from the dashboard) is rewritten as NB_PAT=<token>.
if ! grep -q '^NB_PAT=' secrets.env; then
	bare=$(grep -v '^[[:space:]]*\(#\|$\)' secrets.env | grep -v '=' | tail -n1 | tr -d '[:space:]' || true)
	[[ -n $bare ]] || { echo "no token in secrets.env (expected NB_PAT=<token> or the bare token on a line)" >&2; exit 1; }
	{ printf 'NB_PAT=%s\n' "$bare"; grep -v '=' secrets.env | grep -v '^[[:space:]]*\(#\|$\)' | wc -l | awk '{ if ($1 > 1) print "# NOTE: " $1 " bare token lines were found, the last one was used" }'; grep '=' secrets.env || true; } >secrets.env.new
	mv secrets.env.new secrets.env; chmod 600 secrets.env; echo "  secrets.env: bare token line rewritten as NB_PAT="
fi
NB_PAT=$(grep '^NB_PAT=' secrets.env | tail -n1 | cut -d= -f2- | tr -d '[:space:]\r"'"'")
[[ -n $NB_PAT ]] || { echo "NB_PAT is empty in secrets.env" >&2; exit 1; }
command -v jq >/dev/null && command -v curl >/dev/null || { echo "jq and curl are required" >&2; exit 1; }

BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
# api METHOD PATH [JSON]: prints the response body, fails with the status and NetBird's message (never the token)
api() {
	local method=$1 path=$2 data=${3:-} code
	local args=(-sS --max-time 20 -o "$BODY" -w '%{http_code}' -X "$method" -K - -H 'Accept: application/json')
	[[ -n $data ]] && args+=(-H 'Content-Type: application/json' --data "$data")
	code=$(printf 'header = "Authorization: Token %s"\n' "$NB_PAT" | curl "${args[@]}" "$NB_URL/api/$path") || { echo "request $method $path failed" >&2; return 1; }
	if [[ $code != 2* ]]; then echo "$method $path -> HTTP $code: $(head -c 300 "$BODY")" >&2; return 1; fi
	cat "$BODY"
}

echo "== who am I"
# informational only: some roles may not read /users/current; the real calls below show whether the role is sufficient
if me=$(api GET users/current 2>/dev/null); then echo "  $(jq -r '"\(.name // .email) role=\(.role) service_user=\(.is_service_user // false)"' <<<"$me")"
else echo "  (users/current is not readable with this token; continuing)"; fi
if ! api GET groups >/dev/null 2>"$BODY.err"; then
	echo "  the token cannot read groups: $(cat "$BODY.err")" >&2
	if grep -q 'HTTP 40[14]' "$BODY.err" 2>/dev/null || grep -qi 'invalid token\|not found' "$BODY.err" 2>/dev/null; then
		echo "  -> NetBird does not know this token (revoked, mistyped, or an old line in secrets.env). Create a new token and keep only that one in the file: NB_PAT=<token>" >&2
	else echo "  -> the token is valid but not allowed to read groups: the service user needs the role Admin or Network Admin" >&2; fi
	rm -f "$BODY.err"; exit 1
fi
rm -f "$BODY.err"

group_id() { # name -> id, creates the group when missing
	local name=$1 id
	id=$(api GET groups | jq -r --arg n "$name" '.[] | select(.name == $n) | .id' | head -n1)
	if [[ -z $id ]]; then id=$(api POST groups "$(jq -nc --arg n "$name" '{name: $n}')" | jq -r .id); echo "  group $name created" >&2; else echo "  group $name exists" >&2; fi
	printf '%s' "$id"
}
echo "== groups"
G_HOSTS=$(group_id space-hosts); G_ADMIN=$(group_id space-admin); G_OBS=$(group_id space-observer)

# persist a value in secrets.env (replace or append), mode 600
store() { local k=$1 v=$2; touch secrets.env; chmod 600 secrets.env; grep -v "^$k=" secrets.env >secrets.env.new || true; printf '%s=%s\n' "$k" "$v" >>secrets.env.new; mv secrets.env.new secrets.env; chmod 600 secrets.env; }

setup_key() { # name group-id env-var
	local name=$1 gid=$2 var=$3 existing
	existing=$(api GET setup-keys | jq -r --arg n "$name" '.[] | select(.name == $n and (.revoked | not) and (.valid // true)) | .id' | head -n1)
	if [[ -n $existing && ${NB_ROTATE_KEYS:-0} == 1 ]]; then api PUT "setup-keys/$existing" '{"revoked": true, "auto_groups": []}' >/dev/null; echo "  setup key $name revoked" >&2; existing=""; fi
	if [[ -n $existing ]]; then
		if grep -q "^$var=" secrets.env; then echo "  setup key $name exists, value in secrets.env ($var)" >&2
		else echo "  setup key $name exists but its value is not in secrets.env (shown only at creation): run with NB_ROTATE_KEYS=1" >&2; fi
		return 0
	fi
	local key
	key=$(api POST setup-keys "$(jq -nc --arg n "$name" --arg g "$gid" '{name: $n, type: "reusable", expires_in: 2592000, auto_groups: [$g], usage_limit: 0, ephemeral: false}')" | jq -r .key)
	[[ -n $key && $key != null ]] || { echo "no key in the response for $name" >&2; return 1; }
	store "$var" "$key"; echo "  setup key $name created (30 days, reusable), stored as $var in secrets.env" >&2
}
echo "== setup keys"
setup_key testbed-hosts "$G_HOSTS" NB_KEY_HOSTS
setup_key testbed-admin "$G_ADMIN" NB_KEY_ADMIN

# the agent containers get only their setup key and the management URL, never the API token
write_peer_env() { # file env-var
	local file=$1 var=$2 key
	key=$(grep "^$var=" secrets.env | tail -n1 | cut -d= -f2- || true)
	[[ -n $key ]] || { echo "  $file not written: $var is not in secrets.env (run with NB_ROTATE_KEYS=1)" >&2; return 0; }
	printf 'NB_SETUP_KEY=%s\nNB_MANAGEMENT_URL=%s\n' "$key" "$NB_URL" >"$file.new"; chmod 600 "$file.new"; mv "$file.new" "$file"
	echo "  $file written (setup key + management URL only)" >&2
}
echo "== peer env files"
write_peer_env peer-hosts.env NB_KEY_HOSTS
write_peer_env peer-admin.env NB_KEY_ADMIN

policy() { # name description sources-json dest-id protocol ports-json
	local name=$1 desc=$2 src=$3 dst=$4 proto=$5 ports=$6 pid body
	body=$(jq -nc --arg n "$name" --arg d "$desc" --argjson s "$src" --arg t "$dst" --arg p "$proto" --argjson ports "$ports" \
		'{name: $n, description: $d, enabled: true, rules: [{name: $n, description: $d, enabled: true, action: "accept", bidirectional: false, protocol: $p, ports: $ports, sources: $s, destinations: [$t]}]}')
	pid=$(api GET policies | jq -r --arg n "$name" '.[] | select(.name == $n) | .id' | head -n1)
	if [[ -n $pid ]]; then api PUT "policies/$pid" "$body" >/dev/null; echo "  policy $name updated" >&2
	else api POST policies "$body" >/dev/null; echo "  policy $name created" >&2; fi
}
echo "== policies (only these ports, one direction: clients -> hosts)"
policy space-port "space service: hosts, admins and observers reach the hosts' space port" \
	"$(jq -nc --arg a "$G_HOSTS" --arg b "$G_ADMIN" --arg c "$G_OBS" '[$a,$b,$c]')" "$G_HOSTS" tcp "$(jq -nc --arg p "$NB_SPACE_PORT" '[$p]')"
policy space-admin-ssh "ssh from admin devices to the hosts" "$(jq -nc --arg b "$G_ADMIN" '[$b]')" "$G_HOSTS" tcp '["22"]'

echo "== existing policies (the default allow-all policy defeats the group rules; disable it by hand once the groups work)"
api GET policies | jq -r '.[] | "  \(if .enabled then "ON " else "off" end)  \(.name)  ports=\([.rules[].ports // [] | join(",")] | join(";"))  proto=\([.rules[].protocol] | join(","))"'
if [[ ${NB_PRUNE_STALE:-0} == 1 ]]; then
	echo "== stale peers (disconnected, same name as a connected peer)"
	for id in $(api GET peers | jq -r '[.[] | select(.connected)] as $c | .[] | select((.connected | not) and (.name as $n | $c | any(.name == $n))) | .id'); do
		api DELETE "peers/$id" >/dev/null; echo "  peer $id deleted" >&2
	done
fi
echo "== peers (name, id, overlay ip, groups, connected)"
api GET peers | jq -r '.[] | "  \(.name)  id=\(.id)  ip=\(.ip)  groups=\([.groups[].name] | join(","))  connected=\(.connected)  v\(.version)"'
echo "ok"
