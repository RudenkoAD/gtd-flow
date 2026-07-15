/**
 * Стабильная сериализация QuerySpec — компонента ключа мемоизации
 * (epoch, today, specHash). Отдельный модуль, чтобы тестировать без сторов.
 */
import type { QuerySpec } from "../../core/query/querySpec";

/**
 * JSON с отсортированными ключами объектов: порядок вставки полей не влияет
 * на результат. Порядок элементов массивов ЗНАЧИМ (placement — приоритет полей).
 * undefined-поля опускаются, как в JSON.stringify.
 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		// JSON.stringify(undefined) === undefined — нормализуем в "null"
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
	}
	const obj = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const k of Object.keys(obj).sort()) {
		const v = obj[k];
		if (v === undefined) continue;
		parts.push(JSON.stringify(k) + ":" + stableStringify(v));
	}
	return "{" + parts.join(",") + "}";
}

export function specHash(spec: QuerySpec): string {
	return stableStringify(spec);
}
