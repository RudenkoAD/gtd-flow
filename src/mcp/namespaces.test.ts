import { describe, expect, it } from "vitest";
import { ALL_NS, DEFAULT_NS } from "../core/namespace/namespace";
import { DEFAULT_SETTINGS, type GtdFlowSettings } from "../settings/Settings";
import { resolveNamespaceFilter, resolveWriteNamespace } from "./namespaces";

function settingsWith(names: readonly string[]): GtdFlowSettings {
	return {
		...DEFAULT_SETTINGS,
		namespaces: names.map((name, i) => ({ name, root: `Areas/${i}` })),
	};
}

describe("resolveNamespaceFilter", () => {
	it("пусто/undefined → активное пространство настроек", () => {
		const s = settingsWith(["Работа"]);
		expect(resolveNamespaceFilter(undefined, s).active).toBe(DEFAULT_NS);
		expect(resolveNamespaceFilter("  ", s).active).toBe(DEFAULT_NS);
	});

	it("зарезервированные слова при отсутствии одноимённых пространств", () => {
		const s = settingsWith(["Работа"]);
		expect(resolveNamespaceFilter("Все", s).active).toBe(ALL_NS);
		expect(resolveNamespaceFilter("all", s).active).toBe(ALL_NS);
		expect(resolveNamespaceFilter("*", s).active).toBe(ALL_NS);
		expect(resolveNamespaceFilter("Общее", s).active).toBe(DEFAULT_NS);
		expect(resolveNamespaceFilter("common", s).active).toBe(DEFAULT_NS);
		expect(resolveNamespaceFilter("default", s).active).toBe(DEFAULT_NS);
	});

	it("имя пользовательского пространства", () => {
		const s = settingsWith(["Работа", "Личное"]);
		expect(resolveNamespaceFilter("Работа", s).active).toBe("Работа");
	});

	it("пространство, названное зарезервированным словом, НЕ затеняется", () => {
		// пользователь вправе назвать пространство «All» или «Default» — точное
		// имя побеждает зарезервированное слово
		const s = settingsWith(["All", "Default", "Работа"]);
		expect(resolveNamespaceFilter("All", s).active).toBe("All");
		expect(resolveNamespaceFilter("Default", s).active).toBe("Default");
		// регистр не совпал с именем — работает зарезервированное слово
		expect(resolveNamespaceFilter("all", s).active).toBe(ALL_NS);
		expect(resolveNamespaceFilter("default", s).active).toBe(DEFAULT_NS);
	});

	it("неизвестное имя → ошибка со списком доступных", () => {
		const s = settingsWith(["Работа"]);
		expect(() => resolveNamespaceFilter("Хобби", s)).toThrow(/unknown namespace/);
		expect(() => resolveNamespaceFilter("Хобби", s)).toThrow(/'Работа'/);
	});
});

describe("resolveWriteNamespace", () => {
	it("агрегат «Все» — не место записи", () => {
		const s = settingsWith(["Работа"]);
		expect(() => resolveWriteNamespace("Все", s)).toThrow(/not a write target/);
	});

	it("пространство с именем «All» — валидное место записи", () => {
		const s = settingsWith(["All"]);
		expect(resolveWriteNamespace("All", s).active).toBe("All");
	});
});
