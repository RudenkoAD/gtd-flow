import type { EstimateField, EstimateValues } from "./provenance";

export interface EstimateExample {
	id: string;
	taskId: string;
	taskText: string;
	scopeId: string;
	tags: readonly string[];
	container: string;
	heading: string | null;
	recurrence: string | null;
	values: EstimateValues;
	/** Only user-confirmed/manual fields are valid labels. */
	confirmedFields: readonly EstimateField[];
	createdAt: string;
}

export interface EstimateQuery {
	taskText: string;
	scopeId: string | null;
	tags: readonly string[];
	container: string;
	heading: string | null;
	recurrence: string | null;
}

export interface RankedEstimateExample {
	example: EstimateExample;
	score: number;
	reasons: string[];
}

/**
 * Deterministic MVP retrieval. This intentionally avoids embeddings until a
 * chronological evaluation proves they materially improve correction rates.
 */
export function retrieveEstimateExamples(
	examples: readonly EstimateExample[],
	query: EstimateQuery,
	field: EstimateField,
	limit = 5,
): RankedEstimateExample[] {
	if (!Number.isSafeInteger(limit) || limit < 0 || limit > 20) {
		throw new Error("estimate-example-limit-out-of-range");
	}
	const queryTokens = lexicalTokens(query.taskText);
	const queryBigrams = characterNgrams(query.taskText, 2);
	const queryTags = new Set(query.tags.map(normalizeTag));

	return examples
		.filter((example) => example.confirmedFields.includes(field))
		.map((example) => {
			const reasons: string[] = [];
			let score = 0;
			const wordScore = jaccard(queryTokens, lexicalTokens(example.taskText));
			const charScore = jaccard(queryBigrams, characterNgrams(example.taskText, 2));
			score += wordScore * 6 + charScore * 2;
			if (query.scopeId !== null && query.scopeId === example.scopeId) {
				score += 2;
				reasons.push("scope");
			}
			const sharedTags = [...new Set(example.tags.map(normalizeTag))].filter((tag) =>
				queryTags.has(tag),
			).length;
			if (sharedTags > 0) {
				score += Math.min(sharedTags, 3);
				reasons.push("tags");
			}
			if (query.container === example.container) {
				score += 0.75;
				reasons.push("container");
			}
			if (
				normalizeOptional(query.heading) !== null &&
				normalizeOptional(query.heading) === normalizeOptional(example.heading)
			) {
				score += 0.75;
				reasons.push("heading");
			}
			if (
				normalizeOptional(query.recurrence) !== null &&
				normalizeOptional(query.recurrence) === normalizeOptional(example.recurrence)
			) {
				score += 1;
				reasons.push("recurrence");
			}
			if (wordScore > 0) reasons.push("words");
			if (charScore > 0) reasons.push("wording");
			return { example, score: roundScore(score), reasons };
		})
		.filter((candidate) => candidate.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score ||
				right.example.createdAt.localeCompare(left.example.createdAt) ||
				left.example.id.localeCompare(right.example.id),
		)
		.slice(0, limit);
}

export function lexicalTokens(text: string): Set<string> {
	return new Set(
		normalizeText(text)
			.split(/[^\p{L}\p{N}]+/u)
			.filter((token) => token.length > 1),
	);
}

export function characterNgrams(text: string, size: number): Set<string> {
	if (!Number.isSafeInteger(size) || size < 1 || size > 5) throw new Error("invalid-ngram-size");
	const normalized = normalizeText(text).replace(/\s+/gu, " ");
	if (normalized.length < size) return normalized === "" ? new Set() : new Set([normalized]);
	const grams = new Set<string>();
	for (let index = 0; index <= normalized.length - size; index++) {
		grams.add(normalized.slice(index, index + size));
	}
	return grams;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	if (left.size === 0 && right.size === 0) return 0;
	let intersection = 0;
	for (const item of left) if (right.has(item)) intersection++;
	return intersection / (left.size + right.size - intersection);
}

function normalizeText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function normalizeTag(value: string): string {
	return normalizeText(value.startsWith("#") ? value.slice(1) : value);
}

function normalizeOptional(value: string | null): string | null {
	if (value === null) return null;
	const normalized = normalizeText(value);
	return normalized === "" ? null : normalized;
}

function roundScore(score: number): number {
	return Math.round(score * 1_000_000) / 1_000_000;
}
