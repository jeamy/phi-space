import test from "node:test";
import { exerciseFederationRuntime } from "./test/support/federation-runtime.ts";
test("two persistent runtimes: bootstrap, boot authorization, grant-only data access, expiry/resolution, key rotation and reopen", exerciseFederationRuntime);
