# The identity provider on this machine

Keycloak with its database in Docker: the OpenID provider spaces-files and codemode-forum sign people in with
(`docs/forum-seite-plan-2026-11-26.en.md`, phase 0). A compose project of its own, `phi-idp`, published on a loopback
port; nothing here runs on a server yet.

```bash
cp idp/.env.example idp/.env        # set every secret; the file is ignored by git
docker compose --env-file idp/.env -f idp/docker-compose.yml -p phi-idp up -d
docker compose -p phi-idp logs -f keycloak
docker compose -p phi-idp stop      # `down -v` also removes the database with every account
```

- **Issuer:** `http://localhost:4300/realms/phi` (`IDP_URL` and the realm's name). Both applications compare it
  character by character, and it is stored with every account: the name of the realm is final once a tenant has a
  user bound to it.
- **The realm** `realm/phi.json` is imported on the first start only (`start --import-realm`; a realm that exists is
  left alone). It has two confidential clients, `spaces-files` and `codemode-forum`, each with the code flow alone,
  PKCE S256 required, one redirect URI (`<origin>/auth/callback`) and one post-logout redirect URI (`<origin>/`), and
  one user for development, `dev`, with a fixed ID so that a tenant can be created for it. Secrets, origins and that
  user's password come from the environment of the first start.
- **Admin console:** `http://localhost:4300/admin/`, the bootstrap account of `.env`. On a server it gets a personal
  account with a second factor and the bootstrap account is removed.

spaces-files against it:

```bash
FILES_OIDC_ISSUER=http://localhost:4300/realms/phi FILES_OIDC_CLIENT_ID=spaces-files \
FILES_OIDC_CLIENT_SECRET=<IDP_FILES_SECRET> npm run spaces-files
npm --prefix spaces-files run operator -- create-tenant acme adm adm \
  http://localhost:4300/realms/phi 00000000-0000-4000-8000-000000000001
```

## What Keycloak needed (26.8.2, tried on 2026-11-26)

Walked through without a browser against a spaces-files service of its own (sign in, sign in again, recovery
sign-in, sign out, sign in):

| Step | What happened |
|---|---|
| Sign-in | discovery, the code flow with PKCE, state and nonce, an RS256 ID token: accepted as it is; the tenant's administrator entered |
| Sign-in again while Keycloak's session lives | straight back with a code, no password: one account, one sign-in for both applications |
| Recovery sign-in (`max_age=0`) | Keycloak compares whole seconds and did **not** ask again within the second of the last sign-in; with `prompt=login` beside it, it asks every time. The client sends both |
| Sign-out | the service ends its session and names Keycloak's end-session address; without an ID token hint Keycloak shows a page that asks to confirm, then returns to `<origin>/` |
| Sign-in after the sign-out | the password is asked again |

- An empty `KC_PROXY_HEADERS` stops the start; the variable is set only behind a proxy (`xforwarded`), in the
  server's own compose file.
- `KC_HOSTNAME` takes the whole public address; with plain HTTP on loopback `KC_HTTP_ENABLED=true` is needed.
- The first start takes about half a minute before the realm answers (the import runs after "started").

## On the LAN

For a test from another device, or from a browser that does not reach this machine's loopback, the forum and
Keycloak are served over https on the machine's LAN address with one self-signed certificate (the forum's session
cookie is `__Host-`, Secure, so a plain-HTTP address other than `localhost` cannot sign in; Keycloak's own cookies
need https as well):

```bash
idp/lan.sh 192.168.8.27      # the certificate in .local/lan-tls/, Keycloak on https://192.168.8.27:4301,
                             # the forum's LAN address among the codemode-forum client's redirect URIs
cd codemode-forum && T=$PWD/../.local/lan-tls && set -a && . ../idp/.env && set +a && \
FORUM_BIND=192.168.8.27 FORUM_DEV_ORIGINS=192.168.8.27 FORUM_TLS_CERT=$T/cert.pem FORUM_TLS_KEY=$T/key.pem \
FORUM_MEM=1 FORUM_LOGIN=oidc FORUM_PUBLIC_ORIGIN=https://192.168.8.27:4100 \
FORUM_OIDC_ISSUER=https://192.168.8.27:4301/realms/phi FORUM_OIDC_CA=$T/cert.pem \
FORUM_OIDC_CLIENT_ID=codemode-forum FORUM_OIDC_CLIENT_SECRET="$IDP_FORUM_SECRET" npm run dev
```

The browser warns about the certificate once for each of the two ports. While the LAN file is in use the issuer is
`https://<ip>:4301/realms/phi`; `docker compose --env-file idp/.env -f idp/docker-compose.yml -p phi-idp up -d`
returns to the loopback issuer. Both services listen on the LAN address: anyone on that network reaches them, so it
runs for the test and is stopped afterwards.

## On big

The provider of the servers is `https://id.eibrain.org`, issuer `https://id.eibrain.org/realms/phi`
(`docs/forum-seite-plan-2026-11-26.en.md`, section 13): the same compose project `phi-idp` with
`docker-compose.server.yml` laid over it, on `127.0.0.1:4300` behind nginx (`idp/nginx-id.conf`, certbot).

```bash
idp/server.sh      # on big, in the checkout: idp/.env with new secrets if there is none (mode 600), the realm
                   # without the development user into idp/realm-server/, up, and wait for the issuer
```

- Only `/realms/` and `/resources/` pass nginx (and not the `master` realm). The admin console is reached through an
  ssh tunnel: `ssh -L 4300:127.0.0.1:4300 big`, then `http://localhost:4300/admin/` (`KC_HOSTNAME_ADMIN`).
- The first sign-in to the console is the bootstrap account of `idp/.env` on big. The person then creates their own
  administrator in the `master` realm with a second factor, removes the bootstrap account, and creates their own
  account in the realm `phi`; nobody else types these passwords.
- The forum's client secret is `IDP_FORUM_SECRET` of `idp/.env` on big, given to the forum as
  `FORUM_OIDC_CLIENT_SECRET` in `codemode-forum/.env` there. The realm has the clients' origins
  `https://codeforum.eibrain.org` and `https://spaces-files.eibrain.org` (spaces-files keeps its passwords until
  phase 12 of the plan).
- Its database is dumped daily by `codemode-forum/deploy/forum-backup.sh` (role `big`) and kept on big and nano.
