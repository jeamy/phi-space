// The space and the agent tools together, for runtimes that host both in one process: the mobile bundle
// (scripts/bundle-mobile.mjs) and pi-serverd. The space runs on its own store; the agent's conversations receive its
// events through `withEventSink`.
export * from "../../src/index.ts";
export * from "./agent.ts";
