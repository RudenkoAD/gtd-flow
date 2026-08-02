export interface CryptoRandomSource {
	randomUUID?: () => string;
	getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/** Secure UUID v4 with a getRandomValues fallback for older Android WebViews. */
export function secureUuid(
	cryptoSource: CryptoRandomSource | undefined = globalThis.crypto,
	unavailableReason = "secure-id-generator-unavailable",
): string {
	if (typeof cryptoSource?.randomUUID === "function") return cryptoSource.randomUUID();
	if (typeof cryptoSource?.getRandomValues !== "function") throw new Error(unavailableReason);

	const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
