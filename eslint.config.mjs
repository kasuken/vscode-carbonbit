import typescriptEslint from "typescript-eslint";

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}, {
    // Webview scripts ship as-is (no build step), so lint them as browser scripts.
    files: ["media/**/*.js"],
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: "script",
        globals: {
            acquireVsCodeApi: "readonly",
            window: "readonly",
            document: "readonly",
            ResizeObserver: "readonly",
        },
    },
    rules: {
        "no-undef": "error",
        "no-unused-vars": "warn",
        curly: "warn",
        eqeqeq: "warn",
        semi: "warn",
    },
}];