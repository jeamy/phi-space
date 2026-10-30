// Preloaded by `npm test`: keeps a developer's local .env (space, host name, model switch, limits) out of the tests.
// server/env.ts never overrides variables that are already set, so empty values here win.
process.env.CODEMODE_SPACE = ""; // tests/stack.ts starts a space of its own for every test
process.env.CODEMODE_LISTEN = "";
process.env.CODEMODE_SQLITE = "";
process.env.CODEMODE_JUDGE_LEASE_MS = "";
process.env.CODEMODE_AGENT_LEASE_MS = "";
process.env.CODEMODE_RUN_BUDGET_TOKENS = "";
process.env.CODEMODE_TOKENS_PER_IP_DAY = "";
process.env.CODEMODE_EARLIER_DAYS = "";
process.env.CODEMODE_CROSS_WAIT_S = "";
process.env.CODEMODE_HOST_NAME = "";
process.env.CODEMODE_CHAT_LLM = "0";
process.env.CODEMODE_ADMIN_TOKEN = "";
process.env.CODEMODE_ADMIN_PASSWORD = "";
process.env.CODEMODE_TTL_HOURS = "";
process.env.CODEMODE_MAX_TIMEOUT_S = "";
process.env.CODEMODE_REQ_PER_MIN = "100000"; // the tests poll snapshots in tight loops; the quota has its own test
process.env.CODEMODE_SEARCH_PER_DAY = "";
process.env.CODEMODE_VERDICT_WAIT_S = "";
process.env.CODEMODE_MODEL_WAIT_S = "";
process.env.CODEMODE_DURABLE_AGENT = "0";
process.env.CODEMODE_DURABLE_STORE = "";
process.env.CODEMODE_DURABLE_MODELS_MODULE = "";
