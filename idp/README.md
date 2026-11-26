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
