/**
 * Privacy-проекция вхождений внешнего календаря (§4.3 CalDAV-заказа).
 *
 * Чистый шаг между parseIcs и buildMirrorFile:
 * - "details": остаются только название/время/место, причём SUMMARY и
 *   LOCATION санируются — URI-, mailto:- и email-подобные подстроки
 *   вырезаются (продюсеры встраивают конференц-ссылки и контакты прямо в
 *   разрешённые поля), символ «#» удаляется (иначе «Sprint #alpha» станет
 *   реальным тегом строки задачи); опустевшее название → generic-заголовок.
 * - "busy": generic-заголовок и только дата/время, место не переносится.
 *
 * Описания/участники/организаторы/вложения сюда попасть не могут структурно:
 * MirrorOccurrence этих полей не имеет (см. icsParse).
 */
import type { MirrorOccurrence } from "../icsParse";

/** Generic-заголовок busy-режима (§4.3 таблица заказа). */
export const BUSY_TITLE = "Рабочая встреча";

export type MirrorPrivacyMode = "details" | "busy";

const URI_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const MAILTO_RE = /\bmailto:\S+/gi;
const EMAIL_RE = /\S+@\S+/g;

/** Санация текстового поля details-режима: без URI/mailto/email/#. */
export function sanitizeProjectedText(raw: string): string {
	return raw
		.replace(URI_RE, " ")
		.replace(MAILTO_RE, " ")
		.replace(EMAIL_RE, " ")
		.replace(/#/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Применить режим приватности ко всем вхождениям. Детерминированно; не
 *  меняет идентичность (uid/recurrenceKey/дни) — только title/location. */
export function projectOccurrences(
	occurrences: readonly MirrorOccurrence[],
	privacy: MirrorPrivacyMode,
): MirrorOccurrence[] {
	return occurrences.map((occ) => {
		if (privacy === "busy") {
			return { ...occ, title: BUSY_TITLE, location: null };
		}
		const title = sanitizeProjectedText(occ.title);
		const location = occ.location === null ? null : sanitizeProjectedText(occ.location);
		return {
			...occ,
			title: title === "" ? BUSY_TITLE : title,
			location: location === "" ? null : location,
		};
	});
}
