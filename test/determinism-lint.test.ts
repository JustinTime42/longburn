import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

describe("simulation determinism lint guard", () => {
  it("rejects wall-clock access patterns that would bypass property restrictions", async () => {
    const eslint = new ESLint();

    const [result] = await eslint.lintFiles(["test/fixtures/sim/wall-clock-access.ts"]);

    // Date.now() is deliberately caught by both the legacy property rule and
    // the syntax guard; the remaining four expressions each add one error.
    expect(result.errorCount).toBe(6);
  });
});
