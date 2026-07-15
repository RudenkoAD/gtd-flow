import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		alias: [
			{
				// пакет 'obsidian' — только типы, без runtime-энтри: без алиаса vite
				// не резолвит его даже под vi.mock (см. src/testing/obsidianStub.ts)
				find: "obsidian",
				replacement: fileURLToPath(new URL("./src/testing/obsidianStub.ts", import.meta.url)),
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
