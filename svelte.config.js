import { sveltePreprocess } from "svelte-preprocess";

/** Shared compiler configuration for Vite and the semantic Svelte gate. */
export default {
	preprocess: sveltePreprocess(),
};
