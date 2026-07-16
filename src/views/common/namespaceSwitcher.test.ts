import { describe, expect, it } from "vitest";
import { DEFAULT_NS, type NamespaceDef } from "../../core/namespace/namespace";
import { DEFAULT_NS_LABEL, namespaceLabel, namespaceOptions } from "./namespaceSwitcher";

describe("namespaceOptions", () => {
	it("пустой список — только «Общее»", () => {
		expect(namespaceOptions([])).toEqual([{ value: DEFAULT_NS, label: DEFAULT_NS_LABEL }]);
	});

	it("«Общее» первым, затем именованные в порядке настроек", () => {
		const defs: NamespaceDef[] = [
			{ name: "Работа", root: "Areas/Work" },
			{ name: "Личное", root: "Areas/Personal" },
		];
		expect(namespaceOptions(defs)).toEqual([
			{ value: DEFAULT_NS, label: DEFAULT_NS_LABEL },
			{ value: "Работа", label: "Работа" },
			{ value: "Личное", label: "Личное" },
		]);
	});
});

describe("namespaceLabel", () => {
	it("DEFAULT_NS → «Общее»", () => {
		expect(namespaceLabel(DEFAULT_NS)).toBe(DEFAULT_NS_LABEL);
	});

	it("именованное — своё имя", () => {
		expect(namespaceLabel("Работа")).toBe("Работа");
	});
});
