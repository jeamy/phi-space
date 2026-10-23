// The helpers of the live codemode example (no model is called here).
import { describe, test, expect } from "./compat.ts";

describe("codemode-evolve-live helpers", () => {
	test("extractCode takes the first fenced block, else the whole answer", async () => {
		const { extractCode } = await import("../../examples/codemode-evolve-live.ts");
		expect(extractCode("Here:\n```js\nfunction a(){}\n```\nbye")).toBe("function a(){}");
		expect(extractCode("function b(){}")).toBe("function b(){}");
	});
});
