#!/usr/bin/env bash
# Keycloak on big (idp/README.md "On big"): the compose project phi-idp with docker-compose.server.yml, on
# 127.0.0.1:4300 behind the nginx site of id.eibrain.org (idp/nginx-id.conf).
#   idp/server.sh          writes idp/.env with new secrets if there is none, the realm without its development user
#                          into idp/realm-server/, starts or updates the project and waits for the realm
# The secrets stay in idp/.env on the server (mode 600); the forum's client secret is IDP_FORUM_SECRET there.
set -euo pipefail
cd "$(dirname "$0")"
URL=${IDP_URL:-https://id.eibrain.org}

if [ ! -f .env ]; then
	secret() { head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40; }
	umask 077
	cat > .env <<EOF
IDP_DB_PASSWORD=$(secret)
IDP_ADMIN=admin
IDP_ADMIN_PASSWORD=$(secret)
IDP_URL=$URL
IDP_PORT=4300
IDP_FILES_ORIGIN=https://spaces-files.eibrain.org
IDP_FILES_SECRET=$(secret)
IDP_FORUM_ORIGIN=https://codeforum.eibrain.org
IDP_FORUM_SECRET=$(secret)
# required by docker-compose.yml; the server's realm has no development user
IDP_DEV_USER_PASSWORD=$(secret)
EOF
	echo "wrote idp/.env with new secrets (the bootstrap admin's password is IDP_ADMIN_PASSWORD there)"
fi

mkdir -p realm-server
node -e '
const fs = require("node:fs");
const realm = JSON.parse(fs.readFileSync("realm/phi.json", "utf8"));
delete realm.users;
fs.writeFileSync("realm-server/phi.json", JSON.stringify(realm, null, 2) + "\n");
'

docker compose --env-file .env -f docker-compose.yml -f docker-compose.server.yml -p phi-idp up -d
issuer="$(grep '^IDP_URL=' .env | cut -d= -f2-)/realms/phi"
for _ in $(seq 1 90); do
	got=$(curl -fsS "http://127.0.0.1:$(grep '^IDP_PORT=' .env | cut -d= -f2- || echo 4300)/realms/phi/.well-known/openid-configuration" 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).issuer)}catch{}})' || true)
	if [ "$got" = "$issuer" ]; then echo "realm phi answers, issuer $got"; exit 0; fi
	sleep 2
done
echo "the realm did not answer with the issuer $issuer" >&2
exit 1
