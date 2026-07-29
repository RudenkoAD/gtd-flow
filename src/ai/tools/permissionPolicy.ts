export type ToolRisk = "read" | "reversible-write" | "destructive-or-bulk";

export type ToolPermissionDecision = "execute" | "require-approval";

/**
 * Permission is decided solely by code-owned risk metadata. Model prose and
 * vault content are never consulted and therefore cannot self-authorize.
 */
export function permissionForRisk(risk: ToolRisk): ToolPermissionDecision {
	// Runtime registration is a security boundary, not merely a TypeScript
	// boundary. Any future or malformed risk value must fail closed.
	return risk === "read" || risk === "reversible-write" ? "execute" : "require-approval";
}
