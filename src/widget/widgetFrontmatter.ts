/**
 * Bounded frontmatter reader for the QuickJS widget bundle.
 *
 * The MCP owns complete YAML parsing and mutation through `yaml`.  Pulling that
 * package into the widget is unnecessary: indexing consumes only container
 * flags, card id, and project status. This reader accepts the
 * one-line scalar forms of exactly those fields, then feeds the same core
 * projection as the MCP.  Unsupported or malformed relevant syntax is refused
 * rather than guessed, so it cannot create a positive container classification.
 */
import {
	CONTAINER_FRONTMATTER_KEYS,
	frontmatterBlock,
	projectContainerFrontmatter,
	type ContainerFrontmatter,
} from "../core/frontmatter/containerFrontmatter";

/** A plain top-level key followed by a block-mapping value separator. */
const KEY_RE = /^([^ \t#[\]{},][^:\r\n]*?)[ \t]*:(.*)$/u;
const MALFORMED = Symbol("malformed widget frontmatter scalar");
const UNSUPPORTED = Symbol("unsupported widget frontmatter scalar");

type ScalarResult = string | number | boolean | null | typeof MALFORMED | typeof UNSUPPORTED;

/**
 * Read the small source-level input to the shared projection. Values unrelated
 * to indexing are not parsed at all. `null` means no usable leading block (or a
 * malformed relevant field); `{}` is a valid block with no consumed fields.
 */
export function parseWidgetFrontmatter(content: string): Record<string, unknown> | null {
	const block = frontmatterBlock(content);
	if (block === null || block === "unterminated") return null;

	const out: Record<string, unknown> = {};
	const seenKeys = new Set<string>();
	const lines = block.yaml.split("\n");
	if (!validIndentedStructure(lines)) return null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.replace(/\r$/, "");
		if (line.trim() === "" || line.trimStart().startsWith("#") || /^[ \t]/.test(line)) continue;
		const entry = parseTopLevelEntry(line);
		// A full YAML parser rejects duplicate map keys and obvious broken scalar
		// syntax even when the field is unrelated to GTD. Catch that cheap subset
		// before projecting, while still leaving nested board data alone.
		if (entry === MALFORMED || seenKeys.has(entry.key) || !validTopLevelValue(entry.value)) {
			return null;
		}
		seenKeys.add(entry.key);
		const { key } = entry;
		if (!CONTAINER_FRONTMATTER_KEYS.has(key)) continue;
		// yaml rejects duplicate mapping keys. Treat a duplicate relevant field the
		// same way instead of choosing the last value and silently changing role.
		if (Object.hasOwn(out, key)) return null;

		const scalar = parseScalar(entry.value);
		if (scalar === MALFORMED || relevantContinuation(lines, i)) return null;
		out[key] = scalar;
	}
	return out;
}

interface TopLevelEntry {
	key: string;
	value: string;
}

/** Read a plain or simply quoted top-level mapping key without YAML dependency. */
function parseTopLevelEntry(line: string): TopLevelEntry | typeof MALFORMED {
	const first = line.charAt(0);
	if (first === "'" || first === '"') {
		const quoted = first === "'" ? readSingleQuoted(line) : readDoubleQuoted(line);
		if (quoted === null) return MALFORMED;
		const tail = line.slice(quoted.end + 1);
		const separator = /^[ \t]*:(.*)$/.exec(tail);
		if (separator === null) return MALFORMED;
		const value = mappingValue(separator[1] ?? "");
		return value === MALFORMED ? MALFORMED : { key: quoted.value, value };
	}
	const match = KEY_RE.exec(line);
	if (match === null) return MALFORMED;
	const value = mappingValue(match[2] ?? "");
	return value === MALFORMED ? MALFORMED : { key: match[1]!, value };
}

/** A block-map separator needs whitespace, an inline comment, or end of line after `:`. */
function mappingValue(raw: string): string | typeof MALFORMED {
	if (raw !== "" && !/^[ \t#]/.test(raw)) return MALFORMED;
	return raw.trimStart();
}

/** Reject only obvious scalar breakage; valid nested board mappings stay opaque. */
function validTopLevelValue(raw: string): boolean {
	const value = raw.trim();
	if (value === "") return true;
	const first = value.charAt(0);
	if (first === "'") return parseSingleQuoted(value) !== MALFORMED;
	if (first === '"') return parseDoubleQuoted(value) !== MALFORMED;
	if (first === "[" || first === "{") return balancedFlowCollection(stripPlainComment(value));
	if (first === "]" || first === "}" || first === ",") return false;
	return true;
}

/**
 * Validate only indented lines that visibly begin a mapping or flow value.
 * Ordinary nested board lists/objects remain opaque; this merely catches the
 * same obvious unclosed quoted/flow scalars that the top-level pass catches.
 */
function validIndentedStructure(lines: readonly string[]): boolean {
	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, "");
		if (!/^[ \t]/.test(line)) continue;
		const trimmed = line.trimStart();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const candidate = nestedMappingOrFlow(trimmed);
		if (candidate === null) continue;
		if (candidate.startsWith("[") || candidate.startsWith("{")) {
			if (!balancedFlowCollection(stripPlainComment(candidate))) return false;
			continue;
		}
		const entry = parseTopLevelEntry(candidate);
		if (entry === MALFORMED || !validTopLevelValue(entry.value)) return false;
	}
	return true;
}

/** Return a mapping/list-flow candidate after one YAML list marker, if present. */
function nestedMappingOrFlow(line: string): string | null {
	const list = /^-[ \t]+(.*)$/.exec(line);
	const candidate = list === null ? line : (list[1] ?? "");
	if (candidate.startsWith("[") || candidate.startsWith("{")) return candidate;
	if (KEY_RE.test(candidate)) return candidate;
	if (candidate.startsWith("'") || candidate.startsWith('"')) {
		const quoted =
			candidate.charAt(0) === "'" ? readSingleQuoted(candidate) : readDoubleQuoted(candidate);
		// An unfinished quoted nested scalar is invalid whether it was a key or value.
		if (quoted === null) return candidate;
		return /^[ \t]*:/.test(candidate.slice(quoted.end + 1)) ? candidate : null;
	}
	return null;
}

/** Project bounded source values with the same normalizer used for full MCP YAML. */
export function parseWidgetContainerFrontmatter(content: string): ContainerFrontmatter {
	return projectContainerFrontmatter(parseWidgetFrontmatter(content));
}

/** A continuation would require YAML's multi-line grammar, so refuse it safely. */
function relevantContinuation(lines: readonly string[], lineIndex: number): boolean {
	for (let i = lineIndex + 1; i < lines.length; i++) {
		const line = lines[i]!.replace(/\r$/, "");
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		return /^[ \t]/.test(line);
	}
	return false;
}

function parseScalar(raw: string): ScalarResult {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const first = trimmed.charAt(0);
	if (first === "'") return parseSingleQuoted(trimmed);
	if (first === '"') return parseDoubleQuoted(trimmed);

	const plain = stripPlainComment(trimmed).trim();
	if (plain === "") return null;
	if (plain.startsWith("[") || plain.startsWith("{")) {
		return balancedFlowCollection(plain) ? UNSUPPORTED : MALFORMED;
	}
	// Block scalars, tags, anchors, and aliases have YAML semantics beyond this
	// bounded reader. Refusing the complete block is safer than guessing a flag.
	if (/^[|>&*!%]/.test(plain)) return MALFORMED;
	// An unquoted `: ` begins a nested mapping, not a scalar string.
	if (/:\s/.test(plain)) return UNSUPPORTED;

	const lower = plain.toLowerCase();
	if (lower === "true") return true;
	if (lower === "false") return false;
	if (lower === "null" || plain === "~") return null;
	const numeric = parseYamlNumber(plain);
	return numeric === null ? plain : numeric;
}

/** A YAML comment starts with # at scalar start or when whitespace precedes it. */
function stripPlainComment(value: string): string {
	for (let i = 0; i < value.length; i++) {
		if (value.charAt(i) === "#" && (i === 0 || /[ \t]/.test(value.charAt(i - 1)))) {
			return value.slice(0, i);
		}
	}
	return value;
}

function parseSingleQuoted(value: string): ScalarResult {
	const quoted = readSingleQuoted(value);
	return quoted !== null && quotedTail(value, quoted.end) ? quoted.value : MALFORMED;
}

function parseDoubleQuoted(value: string): ScalarResult {
	const quoted = readDoubleQuoted(value);
	return quoted !== null && quotedTail(value, quoted.end) ? quoted.value : MALFORMED;
}

interface QuotedScalar {
	value: string;
	end: number;
}

function readSingleQuoted(value: string): QuotedScalar | null {
	let out = "";
	for (let i = 1; i < value.length; i++) {
		const ch = value.charAt(i);
		if (ch !== "'") {
			out += ch;
			continue;
		}
		if (value.charAt(i + 1) === "'") {
			out += "'";
			i++;
			continue;
		}
		return { value: out, end: i };
	}
	return null;
}

function readDoubleQuoted(value: string): QuotedScalar | null {
	let out = "";
	for (let i = 1; i < value.length; i++) {
		const ch = value.charAt(i);
		if (ch === '"') return { value: out, end: i };
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const escape = decodeYamlEscape(value, i + 1);
		if (escape === null) return null;
		out += escape.value;
		i = escape.end;
	}
	return null;
}

/** Closing quotes need whitespace before an inline comment; `"value"#x` is invalid YAML. */
function quotedTail(value: string, quoteIndex: number): boolean {
	const tail = value.slice(quoteIndex + 1);
	return /^[ \t]*$/.test(tail) || /^[ \t]+#/.test(tail);
}

function decodeYamlEscape(value: string, index: number): { value: string; end: number } | null {
	const ch = value.charAt(index);
	const simple: Readonly<Record<string, string>> = {
		"0": "\0",
		a: "\u0007",
		b: "\b",
		t: "\t",
		n: "\n",
		v: "\u000b",
		f: "\f",
		r: "\r",
		e: "\u001b",
		" ": " ",
		'"': '"',
		"/": "/",
		"\\": "\\",
		N: "\u0085",
		_: "\u00a0",
		L: "\u2028",
		P: "\u2029",
	};
	if (Object.hasOwn(simple, ch)) return { value: simple[ch]!, end: index };
	const length = ch === "x" ? 2 : ch === "u" ? 4 : ch === "U" ? 8 : 0;
	if (length === 0) return null;
	const hex = value.slice(index + 1, index + 1 + length);
	if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) return null;
	const point = Number.parseInt(hex, 16);
	if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
	return { value: String.fromCodePoint(point), end: index + length };
}

/** Matches the numeric forms used by the MCP's YAML 1.2 core schema. */
function parseYamlNumber(value: string): number | null {
	const lower = value.toLowerCase();
	if (/^[+-]?\.inf$/.test(lower)) return lower.startsWith("-") ? -Infinity : Infinity;
	if (/^[+-]?\.nan$/.test(lower)) return Number.NaN;
	if (!/^[+-]?(?:0x[0-9a-f]+|0o[0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(value))
		return null;
	const parsed = Number(value);
	return Number.isNaN(parsed) ? null : parsed;
}

/** Enough bracket/quote tracking to distinguish a closed unsupported collection from broken YAML. */
function balancedFlowCollection(value: string): boolean {
	const stack: string[] = [];
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < value.length; i++) {
		const ch = value.charAt(i);
		if (quote === '"' && ch === "\\") {
			i++;
			continue;
		}
		if (quote === "'" && ch === "'" && value.charAt(i + 1) === "'") {
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			if (quote === null) quote = ch;
			else if (quote === ch) quote = null;
			continue;
		}
		if (quote !== null) continue;
		if (ch === "[" || ch === "{") stack.push(ch === "[" ? "]" : "}");
		else if (ch === "]" || ch === "}") {
			if (stack.pop() !== ch) return false;
		}
	}
	return quote === null && stack.length === 0;
}
