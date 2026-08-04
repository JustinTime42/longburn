import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/sim/**/*.ts", "test/fixtures/sim/**/*.ts"],
    rules: {
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
