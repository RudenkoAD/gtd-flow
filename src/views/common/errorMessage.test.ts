import { describe, expect, it } from "vitest";
import { describeError } from "./errorMessage";

describe("описание машинных кодов для Notice", () => {
	it("переводит коды с деталями в русский текст", () => {
		expect(describeError(new Error("scope-is-referenced:3"))).toBe(
			"на этот scope ещё ссылаются задачи (3)",
		);
		expect(describeError(new Error("task-metadata-locked:duration,scope"))).toBe(
			"эти поля вы изменили вручную, AI их не перезаписывает: длительность, scope",
		);
		expect(describeError(new Error("inbox-file-unavailable:GTD/Inbox.md"))).toBe(
			"файл входящих недоступен: GTD/Inbox.md",
		);
		expect(describeError(new Error("scope-not-found"))).toBe("scope не найден");
	});

	it("не показывает служебный префикс Error и не теряет незнакомый текст", () => {
		expect(describeError("Error: something-unmapped:42")).toBe("something-unmapped:42");
		expect(describeError(new Error("что-то пошло не так"))).toBe("что-то пошло не так");
	});
});
