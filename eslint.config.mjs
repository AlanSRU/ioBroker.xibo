import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        // build/ is tsc output; admin/ is browser-side config served as-is.
        ignores: ["build/**", "admin/**", "node_modules/**", ".dev-server/**"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parserOptions: { ecmaVersion: 2022, sourceType: "module" },
        },
        rules: {
            // The ioBroker API hands back `any` in several places (state values,
            // message payloads); casting at every boundary would add noise
            // without adding safety, and the values are validated on use.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
        },
    },
);
