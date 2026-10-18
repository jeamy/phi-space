// Set before importing the server: tests must never inherit an operator's remote shard or model setup.
process.env.PI_SPACES_LLM = "0";
process.env.SWARM_REMOTE = "";
process.env.SWARM_AGENTS = "10";
process.env.SWARM_RATE = "1";
