/**
 * Small, dependency-free frontmatter boundary and semantic projection shared by
 * the Obsidian adapter, MCP, and QuickJS widget.  This is deliberately not a
 * YAML parser: the MCP keeps using `yaml` for complete documents and writes;
 * the widget may feed it only its bounded scalar subset.
 */
import type { ContainerKind, FileContext, ProjectStatus } from "../model/Task";

const PROJECT_STATUSES: ReadonlySet<string> = new Set(["active", "on-hold", "done", "archived"]);

/** Keys that affect task-index container semantics. */
export const CONTAINER_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
	"gtd-recurring",
	"gtd-events",
	"gtd-card-of",
	"gtd-project",
	"gtd-board",
	"gtd-archive",
	"gtd-inbox",
	"gtd-external",
	"status",
]);

/** Dependency-free result of reading just the container-relevant frontmatter. */
export interface ContainerFrontmatter {
	container: ContainerKind;
	/** Present only for a project with an explicit effective status. */
	projectStatus?: ProjectStatus;
	/** Present only for an external calendar mirror. */
	external?: true;
}

/** The textual parts of a complete frontmatter block, excluding its delimiters. */
export interface FrontmatterBlock {
	yaml: string;
	body: string;
}

/**
 * Locate the leading Obsidian frontmatter block without parsing YAML.
 *
 * An opening delimiter permits whitespace and a YAML comment.  An unmatched
 * opener is distinct from an absent block so writers can fail closed instead
 * of accidentally creating a second frontmatter block.
 */
export function frontmatterBlock(content: string): FrontmatterBlock | "unterminated" | null {
	const opening = /^---[ \t]*(?:#[^\r\n]*)?\r?\n/.exec(content);
	if (opening === null) return null;
	const rest = content.slice(opening[0].length);

	const immediateClose = /^---[ \t]*(?:\r?\n|$)/.exec(rest);
	if (immediateClose !== null) {
		return { yaml: "", body: rest.slice(immediateClose[0].length) };
	}

	const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(rest);
	if (closing === null) return "unterminated";
	return {
		yaml: rest.slice(0, closing.index),
		body: rest.slice(closing.index + closing[0].length),
	};
}

/**
 * Normalize the exact fields consumed by indexing. Unsupported values never
 * become a positive container classification. Legacy numeric card
 * ids remain supported, but booleans, arrays, and objects do not make cards.
 */
export function projectContainerFrontmatter(
	fm: Record<string, unknown> | null | undefined,
): ContainerFrontmatter {
	const data = fm ?? {};
	const external = data["gtd-external"] === true ? { external: true as const } : {};
	const withCommon = <T extends ContainerFrontmatter>(context: T): T => ({
		...context,
		...external,
	});

	if (data["gtd-recurring"] === true) return withCommon({ container: "recurring" });
	if (data["gtd-events"] === true) return withCommon({ container: "events" });
	if (hasCardId(data["gtd-card-of"])) return withCommon({ container: "card" });
	if (data["gtd-project"] === true) {
		const projectStatus = normalizeProjectStatus(data["status"]);
		return withCommon(
			projectStatus === undefined
				? { container: "project" }
				: { container: "project", projectStatus },
		);
	}
	if (data["gtd-board"] === true) return withCommon({ container: "board" });
	if (data["gtd-archive"] === true) return withCommon({ container: "archive" });
	if (data["gtd-inbox"] === true) return withCommon({ container: "inbox" });
	return withCommon({ container: "plain" });
}

/** Add a path to the projection without re-reading raw frontmatter. */
export function fileContextFromContainerFrontmatter(
	path: string,
	frontmatter: ContainerFrontmatter,
): FileContext {
	return { path, ...frontmatter };
}

/** A card id is an intentional string or finite legacy number, never a truthy object. */
function hasCardId(raw: unknown): boolean {
	if (typeof raw === "string") return raw.trim() !== "";
	return typeof raw === "number" && Number.isFinite(raw);
}

/** Absent/empty status defaults to active; unknown or non-scalar input is on-hold. */
function normalizeProjectStatus(raw: unknown): ProjectStatus | undefined {
	if (raw === null || raw === undefined) return undefined;
	const value = typeof raw === "string" ? raw.trim() : "";
	if (value === "") return typeof raw === "string" ? undefined : "on-hold";
	return PROJECT_STATUSES.has(value) ? (value as ProjectStatus) : "on-hold";
}
