/**
 * Сборка полного текста файла-зеркала внешнего календаря (§внешние календари).
 *
 * ЧИСТАЯ и ДЕТЕРМИНИРОВАННАЯ функция: (развёрнутые вхождения, имя и стабильный
 * ID подписки) → байты файла. Ключевой инвариант — ИДЕМПОТЕНТНОСТЬ: одна и та же
 * лента, развёрнутая в одинаковое окно, даёт БАЙТ-В-БАЙТ одинаковый файл на любом
 * устройстве (при совпадающей таймзоне). Достигается тем, что:
 *  • 🆔 вхождения — детерминированный короткий хэш от (UID + recurrenceKey +
 *    суффикс дня), а recurrenceKey таймзоно-каноничен (см. icsParse);
 *  • строки отсортированы по (дата, время, 🆔) — стабильный порядок;
 *  • frontmatter и заголовок фиксированы.
 *
 * Строки — НАШ обычный формат события (через сериализатор ядра, гарантирующий
 * round-trip): `- [ ] Название 📅 YYYY-MM-DD HH:mm-HH:mm 📍 место 🆔 <id>`.
 *
 * Живёт в src/sync (не core): импортирует ядро-сериализатор, но не obsidian —
 * тестируется в node.
 */
import { setValueField } from "../core/parser/serializeTaskLine";
import type { MirrorOccurrence } from "./icsParse";

/** Parameters for one generated mirror file. */
export interface MirrorFileOptions {
	/** Отображаемое имя подписки (в frontmatter и заголовке). */
	name: string;
	/** Stable subscription identity. SyncService uses it for reconciliation. */
	subscriptionId?: string | null;
}

/**
 * Детерминированный короткий 🆔 вхождения (10 base36-символов) от строки-базы.
 * Два независимых FNV-1a (разные сиды) конкатенируются → ~10 символов; для
 * идентификаторов календаря коллизии практически исключены, а длина скромная.
 * Экспортирован для тестов идемпотентности.
 */
export function externalOccurrenceId(
	occ: Pick<MirrorOccurrence, "uid" | "recurrenceKey" | "dayIndex" | "dayCount">,
): string {
	// суффикс дня — только у многодневных (иначе однодневные не «утяжеляем»)
	const daySuffix = occ.dayCount > 1 ? `\x00d${occ.dayIndex}` : "";
	const base = `${occ.uid}\x00${occ.recurrenceKey}${daySuffix}`;
	const h1 = fnv1a(base, 0x811c9dc5);
	const h2 = fnv1a(base, 0x27d4eb2f);
	const s = (h1 >>> 0).toString(36).padStart(6, "0") + (h2 >>> 0).toString(36).padStart(6, "0");
	return s.slice(0, 10);
}

/** 32-битный FNV-1a с задаваемым сидом (стабилен между платформами). */
function fnv1a(text: string, seed: number): number {
	let h = seed >>> 0;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	}
	return h >>> 0;
}

/** Строка-зеркало одного вхождения (наш формат события) с детерминированным 🆔. */
function mirrorLine(occ: MirrorOccurrence, id: string): string {
	const timeTail =
		occ.allDay || occ.startTime === null
			? ""
			: ` ${occ.startTime}${occ.endTime !== null ? `-${occ.endTime}` : ""}`;
	const titlePart = occ.title === "" ? "" : `${occ.title} `;
	let line = `- [ ] ${titlePart}📅 ${occ.date}${timeTail}`;
	if (occ.location !== null && occ.location !== "") {
		try {
			line = setValueField(line, "location", occ.location);
		} catch {
			// место с эмодзи-поля/тегом сериализатор бы отверг — строка без 📍, а не отказ
		}
	}
	return setValueField(line, "id", id);
}

/** Ключ сортировки времени: all-day (без времени) — вперёд (""), иначе "HH:mm". */
function timeKey(occ: MirrorOccurrence): string {
	return occ.allDay || occ.startTime === null ? "" : occ.startTime;
}

/** Экранирование строки в двойные кавычки YAML (детерминированно, безопасно). */
function yamlString(raw: string): string {
	const s = raw.replace(/\s+/g, " ").trim();
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Полный текст файла-зеркала. Порядок строк стабилен (дата, время, 🆔); 🆔 у
 * вхождения детерминирован (externalOccurrenceId) — повторная сборка той же ленты
 * даёт идентичные байты. Возвращает текст с завершающим переводом строки.
 */
export function buildMirrorFile(
	occurrences: readonly MirrorOccurrence[],
	opts: MirrorFileOptions,
): string {
	const name = opts.name.replace(/\s+/g, " ").trim();
	const subscriptionId =
		typeof opts.subscriptionId === "string" && opts.subscriptionId.trim() !== ""
			? opts.subscriptionId.trim()
			: null;

	// 🆔 считаем один раз, дальше сортируем и печатаем
	const rows = occurrences.map((occ) => ({ occ, id: externalOccurrenceId(occ) }));
	rows.sort((a, b) => {
		if (a.occ.date !== b.occ.date) return a.occ.date < b.occ.date ? -1 : 1;
		const ta = timeKey(a.occ);
		const tb = timeKey(b.occ);
		if (ta !== tb) return ta < tb ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	const front: string[] = [
		"---",
		"gtd-events: true",
		"gtd-external: true",
		`gtd-external-name: ${yamlString(name)}`,
	];
	if (subscriptionId !== null) front.push(`gtd-external-id: ${yamlString(subscriptionId)}`);
	front.push("---");

	const header = `%% Зеркало внешнего календаря «${name}». Правки затираются синхронизацией — не редактируйте вручную. %%`;

	const body = rows.map((r) => mirrorLine(r.occ, r.id));
	return [...front, header, "", ...body].join("\n") + "\n";
}
