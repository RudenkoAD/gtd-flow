import { defineConfig, devices } from "@playwright/test";

const port = 4173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
	testDir: "./browser-tests",
	testMatch: "**/*.spec.ts",
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? [["github"], ["list"]] : "list",
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		trace: "retain-on-failure",
	},
	webServer: {
		command: `npx vite --config vite.browser.config.ts --host 127.0.0.1 --port ${port}`,
		url: baseURL,
		reuseExistingServer: !process.env.CI,
		timeout: 30_000,
	},
});
