#!/usr/bin/env bash
# A test of the sign-in from another device on the LAN (README.md, "On the LAN"): a self-signed certificate for this
# machine's LAN address in .local/lan-tls/ (ignored), Keycloak over https on <ip>:4301, and the forum's LAN address
# among the codemode-forum client's redirect URIs (the realm is imported on the first start only, so it is set here).
#   idp/lan.sh 192.168.8.27
set -euo pipefail
ip=${1:?usage: idp/lan.sh <LAN address of this machine>}
root=$(cd "$(dirname "$0")/.." && pwd)
tls=$root/.local/lan-tls
if [ ! -f "$tls/cert.pem" ] || ! openssl x509 -in "$tls/cert.pem" -noout -ext subjectAltName | grep -q "IP Address:$ip\b" \
	|| ! openssl x509 -in "$tls/cert.pem" -noout -checkend 86400 >/dev/null; then
	mkdir -p "$tls" && chmod 700 "$tls"
	openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$tls/key.pem" -out "$tls/cert.pem" \
		-days 90 -subj "/CN=$ip" -addext "subjectAltName=IP:$ip,DNS:localhost,IP:127.0.0.1" 2>/dev/null
	chmod 600 "$tls/key.pem"
	echo "made $tls/cert.pem for $ip"
fi
set -a; . "$root/idp/.env"; set +a
IDP_LAN_IP=$ip docker compose --env-file "$root/idp/.env" -f "$root/idp/docker-compose.yml" -f "$root/idp/docker-compose.lan.yml" -p phi-idp up -d
issuer=https://$ip:4301/realms/phi
for _ in $(seq 1 90); do curl -sf --cacert "$tls/cert.pem" "$issuer/.well-known/openid-configuration" >/dev/null && break; sleep 2; done
curl -sf --cacert "$tls/cert.pem" "$issuer/.well-known/openid-configuration" >/dev/null || { echo "Keycloak did not answer at $issuer" >&2; exit 1; }

kc() { docker exec -i phi-idp-keycloak-1 /opt/keycloak/bin/kcadm.sh "$@"; }
kc config credentials --server http://localhost:8080 --realm master --user "${IDP_ADMIN:-admin}" --password "$IDP_ADMIN_PASSWORD" >/dev/null
client=$(kc get clients -r phi -q clientId=codemode-forum --fields id,redirectUris,attributes)
id=$(jq -r '.[0].id' <<<"$client")
local_origin=${IDP_FORUM_ORIGIN:-http://localhost:4100}
redirects=$(jq -c --arg a "$local_origin/auth/callback" --arg b "https://$ip:4100/auth/callback" '[$a, $b]' <<<null)
kc update "clients/$id" -r phi -s "redirectUris=$redirects" -s "attributes.\"post.logout.redirect.uris\"=$local_origin/##https://$ip:4100/"
echo "issuer $issuer; the forum's client also takes https://$ip:4100"
