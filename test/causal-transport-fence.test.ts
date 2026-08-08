import { describe, expect, it } from "vitest";
import ts from "typescript";
import type { CausalStateSubscription } from "../src/host/causal-state-egress.js";

const rawWriterNames = new Set(["writeText", "writeJson"]);

const isCausalGateSendCallback = (node: ts.CallExpression): boolean => {
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined && !ts.isArrowFunction(parent)) parent = parent.parent;
  if (parent === undefined || !ts.isArrowFunction(parent) || !ts.isPropertyAssignment(parent.parent)) return false;
  const property = parent.parent;
  if (property.name.getText() !== "send" || !ts.isObjectLiteralExpression(property.parent)) return false;
  const gate = property.parent.parent;
  return ts.isNewExpression(gate) && ts.isIdentifier(gate.expression) && gate.expression.text === "CausalEmissionGate";
};

describe("causal transport boundary", () => {
  it("permits raw server writes only in CausalEmissionGate send callbacks", () => {
    const violations: string[] = [];
    for (const fileName of ts.sys.readDirectory("src/host", [".ts"])) {
      const source = ts.sys.readFile(fileName);
      if (source === undefined) throw new Error(`Cannot read ${fileName}.`);
      const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2024, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          rawWriterNames.has(node.expression.name.text) && !isCausalGateSendCallback(node)) {
          violations.push(`${fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }

    expect(violations).toEqual([]);
  });

  it("does not expose a raw writer from the gate-backed subscription", () => {
    const subscription = null as unknown as CausalStateSubscription;

    // This compile-time contract is the structural fence. If an outbound
    // capability is added to the application-facing subscription, tsc fails.
    if (false) {
      // @ts-expect-error CausalStateSubscription exposes only gate-backed emit.
      subscription.writeText("raw outbound bypass");
    }

    expect(true).toBe(true);
  });
});
