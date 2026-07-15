/**
 * Типы и чистые помощники для карты layout из frontmatter проекта (ТЗ §7):
 * `layout: {id: {x,y}}` — чистая презентация, потеря = авто-layout.
 *
 * ВАЖНО: elkjs здесь НЕ импортируется. Авто-layout выполняется в слое видов;
 * core остаётся свободным от зависимостей (страховка переносимости, ТЗ §0).
 * Здесь только нормализация данных для/после elkjs.
 */

export interface NodePosition {
	x: number;
	y: number;
}

/** id члена проекта (🆔) → позиция узла на полотне. */
export type LayoutMap = Record<string, NodePosition>;

export interface NormalizedLayout {
	/** Позиции только известных членов с валидными конечными координатами. */
	layout: LayoutMap;
	/** Ids из frontmatter, не являющиеся членами, — мусор, кандидат на вычистку. */
	dropped: string[];
	/** Члены без валидной позиции — вход для авто-layout (elkjs в слое видов). */
	missing: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readPosition(v: unknown): NodePosition | null {
	if (!isRecord(v)) return null;
	const x = v["x"];
	const y = v["y"];
	// YAML мог принести что угодно — принимаем только конечные числа
	if (typeof x !== "number" || !Number.isFinite(x)) return null;
	if (typeof y !== "number" || !Number.isFinite(y)) return null;
	return { x, y };
}

/**
 * Нормализация raw-значения frontmatter-ключа `layout`:
 * неизвестные id выбрасываются (dropped), члены без валидной позиции
 * перечисляются в missing. Не-объект на входе = пустая карта.
 */
export function normalizeLayout(raw: unknown, memberIds: readonly string[]): NormalizedLayout {
	const source = isRecord(raw) ? raw : {};
	const members = new Set(memberIds);
	const layout: LayoutMap = {};
	const dropped: string[] = [];
	for (const [id, pos] of Object.entries(source)) {
		if (!members.has(id)) {
			dropped.push(id);
			continue;
		}
		const p = readPosition(pos);
		if (p !== null) layout[id] = p;
		// член с невалидной позицией попадёт в missing ниже
	}
	const missing: string[] = [];
	for (const id of members) {
		if (!(id in layout)) missing.push(id);
	}
	return { layout, dropped, missing };
}
