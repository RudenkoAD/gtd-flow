import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

const nodeGlobals = {
	AbortController: "readonly",
	Buffer: "readonly",
	URL: "readonly",
	URLSearchParams: "readonly",
	console: "readonly",
	clearInterval: "readonly",
	clearTimeout: "readonly",
	fetch: "readonly",
	process: "readonly",
	queueMicrotask: "readonly",
	setInterval: "readonly",
	setTimeout: "readonly",
	structuredClone: "readonly",
};

const correctnessRules = {
	"no-constant-binary-expression": "error",
	"no-fallthrough": "error",
	"no-irregular-whitespace": "error",
	"no-loss-of-precision": "error",
	"no-self-compare": "error",
	"no-throw-literal": "error",
	"no-unreachable-loop": "error",
	"no-unsafe-finally": "error",
	"no-unused-private-class-members": "error",
};

export default tseslint.config(
	{
		ignores: [
			"coverage/**",
			"dist/**",
			"node_modules/**",
			"playwright-report/**",
			"test-results/**",
			"test-vault/**",
			"main.js",
			"mcp-server.js",
			"widget-core.js",
			"*.map",
		],
	},
	{
		files: ["**/*.{js,mjs,cjs}"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: nodeGlobals,
		},
		rules: {
			...correctnessRules,
			"no-undef": "error",
			"no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
			],
		},
	},
	...tseslint.configs.recommended,
	...svelte.configs.recommended,
	{
		files: ["**/*.{ts,svelte}"],
		languageOptions: {
			globals: nodeGlobals,
			parserOptions: {
				extraFileExtensions: [".svelte"],
				parser: tseslint.parser,
			},
		},
		rules: {
			...correctnessRules,
			"@typescript-eslint/consistent-type-imports": [
				"error",
				{ fixStyle: "separate-type-imports", prefer: "type-imports" },
			],
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-empty-object-type": [
				"error",
				{ allowInterfaces: "with-single-extends" },
			],
		},
	},
	{
		files: ["**/*.{test,spec}.{ts,js,mjs,cjs}"],
		rules: {
			"@typescript-eslint/no-explicit-any": "off",
			"no-throw-literal": "off",
		},
	},
);
