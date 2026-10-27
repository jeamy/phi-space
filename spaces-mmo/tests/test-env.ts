// Preloaded by `npm test`: keeps a developer's local .env out of the tests. server/env.ts never overrides variables
// that are already set, so empty values here win.
process.env.SPACES_MMO_SPACE = ""; // tests/stack.ts starts spaces of its own for every test
process.env.SPACES_MMO_ACCOUNTS = "";
process.env.SPACES_MMO_LISTEN = "";
process.env.SPACES_MMO_ACCOUNTS_LISTEN = "";
process.env.SPACES_MMO_DATA = "";
process.env.SPACES_MMO_WORLD = "";
process.env.SPACES_MMO_SETUP_TOKEN = "";
process.env.SPACES_MMO_GUEST_TTL_MS = "";
process.env.SPACES_MMO_PENDING_MS = "";
process.env.SPACES_MMO_WEB_SESSION_MS = "";
process.env.SPACES_MMO_SESSION_LEASE_MS = "";
process.env.SPACES_MMO_CLEANUP_MS = "";
process.env.SPACES_MMO_MSG_LEASE_MS = "";
process.env.SPACES_MMO_REQ_PER_MIN = "100000"; // the tests call in tight loops; the login limit has its own test
process.env.SPACES_MMO_GUESTS_PER_HOUR = "100000";
process.env.SPACES_MMO_CMD_BURST = "100000"; // likewise for typed commands; tests/collision.test.ts tests the limit with a web process of its own
process.env.SPACES_MMO_CMD_PER_SEC = "100000";
process.env.SPACES_MMO_LLM = ""; // never a real model in the tests: a test that wants one names tests/fake-llm.ts
process.env.SPACES_MMO_LLM_MODULE = "";
// the three roles of the earlier phases; the people of the islands (server/npc/economy.ts) would walk through their
// tests, and tests/economy.test.ts plays them itself
process.env.SPACES_MMO_NPCS = "ines,bo,fremder";
