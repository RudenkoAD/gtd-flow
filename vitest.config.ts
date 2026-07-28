import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary", "html"],
			reportsDirectory: "coverage",
			all: true,
			include: ["src/core/**/*.ts", "src/services/**/*.ts", "src/mcp/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/**/*.d.ts",
				"src/testing/**",
				"src/mcp/testVault.ts",
			],
			// Vitest 4's AST-aware V8 baseline for this critical runtime scope:
			// 90.70 statements, 85.27 branches, 91.25 functions, 93.28 lines.
			// Keep roughly a two-point maintenance margin while making coverage
			// loss in core, services, or MCP fail the gate.
			thresholds: {
				branches: 83,
				functions: 89,
				lines: 91,
				statements: 89,
			},
		},
		alias: [
			{
				// пакет 'obsidian' — только типы, без runtime-энтри: без алиаса vite
				// не резолвит его даже под vi.mock (см. src/testing/obsidianStub.ts)
				find: "obsidian",
				replacement: fileURLToPath(
					new URL("./src/testing/obsidianStub.ts", import.meta.url),
				),
			},
			{
				// .svelte-компоненты не компилируются в тестах — классы видов
				// проверяются без монтирования (см. src/testing/svelteStub.ts)
				find: /^.*\.svelte$/,
				replacement: fileURLToPath(new URL("./src/testing/svelteStub.ts", import.meta.url)),
			},
		],
	},
});
