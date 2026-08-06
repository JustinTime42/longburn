import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

describe("simulation determinism lint guard", () => {
  it("applies determinism rules only to simulation code while retaining the causal boundary across src", async () => {
    const eslint = new ESLint();
    const simConfig = await eslint.calculateConfigForFile("src/sim/loop.ts");
    const hostConfig = await eslint.calculateConfigForFile("src/host/tick-driver.ts");

    expect(simConfig.rules["no-restricted-properties"]).toEqual(expect.arrayContaining([2]));
    expect(simConfig.rules["no-restricted-syntax"]).toEqual(expect.arrayContaining([2]));
    expect(simConfig.rules["causal-boundary/no-raw-outbound"]).toEqual([2]);
    expect(hostConfig.rules["no-restricted-properties"]).toBeUndefined();
    expect(hostConfig.rules["no-restricted-syntax"]).toBeUndefined();
    expect(hostConfig.rules["causal-boundary/no-raw-outbound"]).toEqual([2]);
  });

  it("rejects wall-clock access patterns that would bypass property restrictions", async () => {
    // The fixture is ignored during broad linting because it is deliberately
    // invalid. Disable ignores only for this targeted lint run; the fixture
    // still receives the production configuration and rules.
    const eslint = new ESLint({ ignore: false });
    const [result] = await eslint.lintFiles(["test/fixtures/sim/wall-clock-access.ts"]);

    // Date.now() is deliberately caught by both the legacy property rule and
    // the syntax guard; the remaining four expressions each add one error.
    expect(result?.errorCount).toBe(6);
  });
});
