// Preloaded by `npm test`: keeps a developer's local .env (remote shard, host name, model switch) out of the tests.
// server/env.ts never overrides variables that are already set, so empty values here win.
process.env.CODEMODE_REMOTE = "";
process.env.CODEMODE_HOST_NAME = "";
process.env.CODEMODE_CHAT_LLM = "0";
process.env.CODEMODE_ADMIN_TOKEN = "";
process.env.CODEMODE_TTL_HOURS = "";
process.env.CODEMODE_REQ_PER_MIN = "100000"; // the tests poll snapshots in tight loops; the quota has its own test
