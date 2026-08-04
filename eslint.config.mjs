import js from "@eslint/js";
import tseslint from "typescript-eslint";

const rawOutboundNames = new Set(["send", "publish", "broadcast", "write"]);
const causalBoundaryPlugin = {
  rules: {
    "no-raw-outbound": {
      meta: {
        type: "problem",
        docs: { description: "Require CausalEmissionGate for every outbound message." },
        schema: [],
        messages: { rawOutbound: "Outbound messages must pass through CausalEmissionGate." }
      },
      create(context) {
        const isGate = context.filename.endsWith("/src/sim/causality.ts");
        return {
          CallExpression(node) {
            if (isGate) return;
            const callee = node.callee;
            const name = callee.type === "Identifier"
              ? callee.name
              : callee.type === "MemberExpression" || callee.type === "PrivateIdentifier"
                ? callee.property?.name
                : undefined;
            if (rawOutboundNames.has(name)) {
              context.report({ node, messageId: "rawOutbound" });
            }
          }
        };
      }
    }
  }
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // This fixture intentionally violates the sim rules. Its contents are
    // linted by determinism-lint.test.ts using the sim path below instead.
    ignores: ["test/fixtures/**"]
  },
  {
    files: ["src/**/*.ts", "test/fixtures/sim/**/*.ts"],
    plugins: { "causal-boundary": causalBoundaryPlugin },
    rules: {
      "causal-boundary/no-raw-outbound": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "Date",
          property: "now",
          message: "Sim code receives time as input. It must never read the wall clock."
        },
        {
          object: "Math",
          property: "random",
          message: "Sim code must use SeededRng, never unseeded randomness."
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message: "Sim code receives time as input. It must never construct a wall-clock Date."
        },
        {
          selector: "MemberExpression[object.name='Date']",
          message: "Sim code receives time as input. It must never access Date."
        },
        {
          selector: "MemberExpression[object.name='performance']",
          message: "Sim code receives time as input. It must never access performance timing."
        },
        {
          selector: "MemberExpression[object.name='globalThis'][property.name='Date']",
          message: "Sim code receives time as input. It must never access globalThis.Date."
        },
        {
          selector: "MemberExpression[object.name='globalThis'][property.name='performance']",
          message: "Sim code receives time as input. It must never access globalThis.performance."
        },
        {
          selector: "MemberExpression[object.name='globalThis'][property.name='Math']",
          message: "Sim code must use SeededRng, never globalThis.Math randomness."
        }
      ]
    }
  }
);
