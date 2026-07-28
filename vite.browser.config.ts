import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import svelteConfig from "./svelte.config.js";

/**
 * Test-only browser build. Project components run unmodified; just the Obsidian
 * host API is replaced with a deterministic DOM-friendly implementation.
 */
export default defineConfig({
	root: fileURLToPath(new URL("./browser-tests", import.meta.url)),
	plugins: [svelte(svelteConfig)],
	resolve: {
		alias: {
			obsidian: fileURLToPath(
				new URL("./browser-tests/obsidianBrowserStub.ts", import.meta.url),
			),
		},
	},
	server: {
		fs: {
			// The browser entrypoint lives in browser-tests/ but mounts components
			// from the project source tree one level above it.
			allow: [fileURLToPath(new URL(".", import.meta.url))],
		},
	},
});
