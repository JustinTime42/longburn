import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

describe("causal transport boundary", () => {
  it("rejects a raw outbound call outside CausalEmissionGate", async () => {
    const eslint = new ESLint({ ignore: false });
    const [result] = await eslint.lintFiles(["test/fixtures/sim/raw-outbound.ts"]);

    expect(result?.errorCount).toBe(1);
    expect(result?.messages[0]?.message).toContain("CausalEmissionGate");
  });
});
