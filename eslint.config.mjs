import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/sim/**/*.ts"],
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
      ]
    }
  }
);
