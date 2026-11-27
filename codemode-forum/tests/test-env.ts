// Preloaded by `npm test`: keeps a developer's local .env (space, host name, model switch, limits) out of the tests.
// server/env.ts never overrides variables that are already set, so empty values here win.
process.env.FORUM_SPACE = ""; // tests/stack.ts starts a space of its own for every test
process.env.FORUM_LISTEN = "";
process.env.FORUM_SQLITE = "";
process.env.FORUM_AGENT_LEASE_MS = "";
process.env.FORUM_RUN_BUDGET_TOKENS = "";
process.env.FORUM_TOKENS_PER_IP_DAY = "";
process.env.FORUM_HOST_NAME = "";
process.env.FORUM_LLM = "0";
process.env.FORUM_MODELS = "";
process.env.FORUM_ADMIN_PASSWORD = "";
process.env.FORUM_TTL_HOURS = "";
process.env.FORUM_REQ_PER_MIN = "100000"; // the tests poll snapshots in tight loops
process.env.FORUM_MODEL_WAIT_S = "";
process.env.FORUM_REPOS = "";
process.env.FORUM_SOURCE_LEASE_MS = "";
process.env.FORUM_SOURCE_WAIT_S = "";
process.env.FORUM_REPLY_WAIT_S = "";
process.env.FORUM_TURN_WAIT_S = "";
process.env.FORUM_PERSON_WAIT_S = "";
process.env.FORUM_LOGIN = ""; // tests/auth.test.ts names its sign-in itself
process.env.FORUM_PUBLIC_ORIGIN = "";
process.env.FORUM_OIDC_ISSUER = "";
process.env.FORUM_OIDC_CLIENT_ID = "";
process.env.FORUM_OIDC_CLIENT_SECRET = "";
process.env.FORUM_OIDC_CA = "";
process.env.FORUM_ADMINS = "";
process.env.FORUM_TLS_CERT = ""; process.env.FORUM_TLS_KEY = ""; // the suites speak plain HTTP
