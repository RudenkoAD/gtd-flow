/**
 * Заметки конкретного релиза.
 *
 * Преамбула была ЗАШИТА в publish-шаг `.github/workflows/release.yml`, поэтому
 * текст breaking-релиза 0.13.0 («Back up the vault before upgrading…») попадал
 * бы в заметки КАЖДОГО следующего тега — включая патчи вроде 0.13.1, где ни
 * миграции, ни бэкапа не требуется. Теперь текст живёт рядом с версией:
 * `docs/release-notes/<version>.md`. Файла нет — заметки остаются только
 * автогенерируемыми (`gh release create --generate-notes`), что и нужно
 * обычному патчу.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Имя файла заметок внутри immutable release-bundle. */
export const RELEASE_NOTES_FILE = "RELEASE_NOTES.md";

/** Путь к рукописным заметкам версии относительно корня репозитория. */
export function releaseNotesSource(version) {
	return `docs/release-notes/${version}.md`;
}

/** Текст заметок версии; "" — заметок для этой версии нет. */
export function readReleaseNotes(root, version) {
	const source = resolve(root, releaseNotesSource(version));
	if (!existsSync(source)) return "";
	return readFileSync(source, "utf8").trim();
}

/**
 * Положить заметки версии в bundle релиза.
 *
 * Файл создаётся ВСЕГДА: job `publish` не делает checkout и доверяет только
 * тому, что сошлось с `SHA256SUMS`, поэтому состав bundle не должен зависеть от
 * версии — иначе часть заметок ехала бы мимо проверки целостности. «Заметок
 * нет» кодируется ОДНИМ переводом строки, а не нулевым размером: пустые файлы
 * плохо переживают upload/download артефакта, а пропавший файл уронил бы
 * `sha256sum --check`. Publish отличает такой файл по отсутствию непробельных
 * символов и просто не передаёт `--notes-file`.
 */
export function writeReleaseNotes(root, version, outputDir) {
	const text = readReleaseNotes(root, version);
	const destination = resolve(outputDir, RELEASE_NOTES_FILE);
	writeFileSync(destination, `${text}\n`, "utf8");
	return { destination, text, source: text === "" ? null : releaseNotesSource(version) };
}
