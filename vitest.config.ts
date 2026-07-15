import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		alias: {
			// пакет 'obsidian' — только типы, без runtime-энтри: без алиаса vite
			// не резолвит его даже под vi.mock (см. src/testing/obsidianStub.ts)
			obsidian: fileURLToPath(new URL("./src/testing/obsidianStub.ts", import.meta.url)),
		},
	},
});
