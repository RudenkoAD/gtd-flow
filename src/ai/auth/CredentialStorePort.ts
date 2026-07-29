/**
 * Local-only secret store boundary. Implementations must use OS-backed storage
 * or keep a key in memory for the process; vault/data.json implementations are
 * intentionally not provided.
 */
export interface CredentialStorePort {
	get(): Promise<string | null>;
	set(secret: string): Promise<void>;
	clear(): Promise<void>;
}
