import { describe, expect, it } from "vitest";
import {
	DEFAULT_NS,
	inNamespace,
	type NamespaceDef,
	normalizeActiveNamespace,
	normalizeNsPath,
	NS_CONVENTION,
	nsRoot,
	nsTargetPath,
	resolveNamespace,
} from "./namespace";

const WORK: NamespaceDef = { name: "Работа", root: "Work" };
const WORK_SUB: NamespaceDef = { name: "Проект X", root: "Work/Проекты/X" };
const LIFE: NamespaceDef = { name: "Жизнь", root: "Личное" };

describe("normalizeNsPath", () => {
	it("срезает хвостовые слэши и пробелы", () => {
		expect(normalizeNsPath("Work/")).toBe("Work");
		expect(normalizeNsPath("Work///")).toBe("Work");
		expect(normalizeNsPath("  Work/Sub/  ")).toBe("Work/Sub");
	});

	it("корень хранилища ('' или '/') → пустая строка", () => {
		expect(normalizeNsPath("")).toBe("");
		expect(normalizeNsPath("/")).toBe("");
		expect(normalizeNsPath("///")).toBe("");
	});

	it("внутренние сегменты не трогает", () => {
		expect(normalizeNsPath("A/B/C.md")).toBe("A/B/C.md");
	});
});

describe("resolveNamespace — папка", () => {
	const defs = [WORK, LIFE];

	it("пустой список пространств ⇒ всё в DEFAULT_NS", () => {
		expect(resolveNamespace("Work/Inbox.md", null, [])).toBe(DEFAULT_NS);
		expect(resolveNamespace("что угодно.md", null, [])).toBe(DEFAULT_NS);
	});

	it("файл внутри корня ⇒ имя пространства", () => {
		expect(resolveNamespace("Work/Inbox.md", null, defs)).toBe("Работа");
		expect(resolveNamespace("Work/Проекты/задача.md", null, defs)).toBe("Работа");
		expect(resolveNamespace("Личное/дневник.md", null, defs)).toBe("Жизнь");
	});

	it("путь, равный корню (папка целиком) ⇒ имя пространства", () => {
		expect(resolveNamespace("Work", null, defs)).toBe("Работа");
		expect(resolveNamespace("Work/", null, defs)).toBe("Работа");
	});

	it("файл вне всех корней ⇒ DEFAULT_NS", () => {
		expect(resolveNamespace("Заметки/идея.md", null, defs)).toBe(DEFAULT_NS);
		expect(resolveNamespace("todo.md", null, defs)).toBe(DEFAULT_NS);
	});

	it("совпадение ТОЛЬКО по границе сегмента: 'Work' не матчит 'Workspace/...'", () => {
		// префикс строки, но не префикс пути — не должен матчить
		expect(resolveNamespace("Workspace/x.md", null, defs)).toBe(DEFAULT_NS);
		expect(resolveNamespace("Workaround.md", null, defs)).toBe(DEFAULT_NS);
	});

	it("хвостовой слэш в конфиге корня нормализуется (root 'Work/' матчит 'Work/x.md')", () => {
		const withSlash = [{ name: "W", root: "Work/" }];
		expect(resolveNamespace("Work/x.md", null, withSlash)).toBe("W");
	});
});

describe("resolveNamespace — вложенные корни: длиннейший префикс побеждает", () => {
	// Порядок в списке намеренно «неудобный» — длиннейший корень идёт ВТОРЫМ.
	const defs = [WORK, WORK_SUB, LIFE];

	it("файл в глубоком корне достаётся длиннейшему префиксу", () => {
		expect(resolveNamespace("Work/Проекты/X/todo.md", null, defs)).toBe("Проект X");
		expect(resolveNamespace("Work/Проекты/X", null, defs)).toBe("Проект X");
	});

	it("файл в родительском корне (но не в под-корне) достаётся короткому", () => {
		expect(resolveNamespace("Work/Проекты/Y/todo.md", null, defs)).toBe("Работа");
		expect(resolveNamespace("Work/other.md", null, defs)).toBe("Работа");
	});

	it("порядок в списке не влияет — решает длина корня", () => {
		const reordered = [WORK_SUB, LIFE, WORK];
		expect(resolveNamespace("Work/Проекты/X/todo.md", null, reordered)).toBe("Проект X");
		expect(resolveNamespace("Work/Проекты/Z/todo.md", null, reordered)).toBe("Работа");
	});
});

describe("resolveNamespace — override (frontmatter gtd-namespace)", () => {
	const defs = [WORK, LIFE];

	it("непустой override ПЕРЕБИВАЕТ папку", () => {
		// файл лежит в Work/, но override уводит его в «Жизнь»
		expect(resolveNamespace("Work/личная-заметка.md", "Жизнь", defs)).toBe("Жизнь");
	});

	it("override работает для файла ВНЕ любой папки-корня", () => {
		expect(resolveNamespace("Разное/файл.md", "Работа", defs)).toBe("Работа");
	});

	it("override возвращается дословно (нормализация имени = trim), даже если такого пространства нет", () => {
		// членство несуществующего пространства — забота фильтра/UI, не резолвера
		expect(resolveNamespace("любой.md", "Неизвестное", defs)).toBe("Неизвестное");
		expect(resolveNamespace("любой.md", "  Работа  ", defs)).toBe("Работа");
	});

	it("пустой / пробельный / не-строковый override игнорируется ⇒ логика папки", () => {
		expect(resolveNamespace("Work/x.md", "", defs)).toBe("Работа");
		expect(resolveNamespace("Work/x.md", "   ", defs)).toBe("Работа");
		expect(resolveNamespace("Work/x.md", null, defs)).toBe("Работа");
		expect(resolveNamespace("Work/x.md", undefined, defs)).toBe("Работа");
	});
});

describe("nsRoot", () => {
	const defs = [WORK, WORK_SUB, LIFE];

	it("имя пространства ⇒ нормализованный корень", () => {
		expect(nsRoot("Работа", defs)).toBe("Work");
		expect(nsRoot("Проект X", defs)).toBe("Work/Проекты/X");
	});

	it("хвостовой слэш корня нормализуется", () => {
		expect(nsRoot("W", [{ name: "W", root: "Work/" }])).toBe("Work");
	});

	it("неизвестное имя (в т.ч. DEFAULT_NS) ⇒ null", () => {
		expect(nsRoot("Нет такого", defs)).toBeNull();
		expect(nsRoot(DEFAULT_NS, defs)).toBeNull();
	});
});

describe("inNamespace — предикат фильтра", () => {
	const defs = [WORK, LIFE];

	it("пустой defs ⇒ прозрачен (true) при любом active", () => {
		expect(inNamespace("Work/x.md", null, { active: "Работа", defs: [] })).toBe(true);
		expect(inNamespace("todo.md", null, { active: DEFAULT_NS, defs: [] })).toBe(true);
	});

	it("активное именованное пространство пропускает свои файлы и режет чужие", () => {
		const f = { active: "Работа", defs };
		expect(inNamespace("Work/x.md", null, f)).toBe(true);
		expect(inNamespace("Личное/x.md", null, f)).toBe(false);
		expect(inNamespace("Разное/x.md", null, f)).toBe(false); // «Общее» — не «Работа»
	});

	it("активное DEFAULT_NS («Общее») пропускает только файлы вне корней", () => {
		const f = { active: DEFAULT_NS, defs };
		expect(inNamespace("Разное/x.md", null, f)).toBe(true);
		expect(inNamespace("Work/x.md", null, f)).toBe(false);
	});

	it("override учитывается предикатом (файл из Work виден в «Жизнь» при override)", () => {
		const f = { active: "Жизнь", defs };
		expect(inNamespace("Work/личное.md", "Жизнь", f)).toBe(true);
		expect(inNamespace("Work/рабочее.md", null, f)).toBe(false);
	});
});

describe("normalizeActiveNamespace", () => {
	const defs = [WORK, LIFE];

	it("DEFAULT_NS всегда валиден", () => {
		expect(normalizeActiveNamespace(DEFAULT_NS, defs)).toBe(DEFAULT_NS);
		expect(normalizeActiveNamespace(DEFAULT_NS, [])).toBe(DEFAULT_NS);
	});

	it("существующее среди defs имя сохраняется", () => {
		expect(normalizeActiveNamespace("Работа", defs)).toBe("Работа");
		expect(normalizeActiveNamespace("Жизнь", defs)).toBe("Жизнь");
	});

	it("удалённое из defs имя откатывается к DEFAULT_NS", () => {
		expect(normalizeActiveNamespace("Работа", [LIFE])).toBe(DEFAULT_NS);
		expect(normalizeActiveNamespace("Работа", [])).toBe(DEFAULT_NS);
		expect(normalizeActiveNamespace("Неизвестное", defs)).toBe(DEFAULT_NS);
	});
});

describe("nsTargetPath — цели создания по конвенции", () => {
	const defs = [WORK, WORK_SUB, LIFE];

	it("именованное пространство ⇒ <root>/<suffix>", () => {
		expect(nsTargetPath("Работа", defs, NS_CONVENTION.inbox, "GTD/Inbox.md")).toBe(
			"Work/Входящие.md",
		);
		expect(nsTargetPath("Жизнь", defs, NS_CONVENTION.events, "GTD/Events.md")).toBe(
			"Личное/События.md",
		);
		expect(nsTargetPath("Работа", defs, NS_CONVENTION.boardsDir, "GTD/Boards")).toBe("Work/Доски");
	});

	it("вложенный корень использует свой самый длинный root", () => {
		expect(nsTargetPath("Проект X", defs, NS_CONVENTION.archive, "GTD/Archive.md")).toBe(
			"Work/Проекты/X/Архив.md",
		);
	});

	it("DEFAULT_NS ⇒ fallback (существующая глобальная настройка)", () => {
		expect(nsTargetPath(DEFAULT_NS, defs, NS_CONVENTION.inbox, "GTD/Inbox.md")).toBe("GTD/Inbox.md");
		expect(nsTargetPath(DEFAULT_NS, defs, NS_CONVENTION.recurring, "GTD/Recurring.md")).toBe(
			"GTD/Recurring.md",
		);
	});

	it("неизвестное имя (нет среди defs) ⇒ fallback", () => {
		expect(nsTargetPath("Нет такого", defs, NS_CONVENTION.inbox, "GTD/Inbox.md")).toBe(
			"GTD/Inbox.md",
		);
	});

	it("пустой/корневой root пространства ⇒ fallback (root не выделяет пространство)", () => {
		const rooted = [{ name: "Корневое", root: "/" }];
		expect(nsTargetPath("Корневое", rooted, NS_CONVENTION.inbox, "GTD/Inbox.md")).toBe(
			"GTD/Inbox.md",
		);
	});
});

describe("DEFAULT_NS — sentinel", () => {
	it("не совпадает с обычными пользовательскими именами", () => {
		expect(DEFAULT_NS).not.toBe("default");
		expect(DEFAULT_NS).not.toBe("Общее");
		expect(DEFAULT_NS.endsWith("default")).toBe(true);
		// содержит непечатный префикс (NUL) — недостижим вводом с клавиатуры
		expect(DEFAULT_NS.charCodeAt(0)).toBe(0);
	});
});
