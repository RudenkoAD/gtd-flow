import type { CredentialStorePort } from "./CredentialStorePort";

/**
 * Fail-closed credential fallback for the MVP. The OpenRouter key survives only
 * for this Obsidian process and is never serialized into the vault or data.json.
 */
export class MemoryCredentialStore implements CredentialStorePort {
	#secret: string | null = null;

	async get(): Promise<string | null> {
		return this.#secret;
	}

	async set(secret: string): Promise<void> {
		if (secret.trim() === "") throw new Error("empty-credential");
		this.#secret = secret;
	}

	async clear(): Promise<void> {
		this.#secret = null;
	}
}
