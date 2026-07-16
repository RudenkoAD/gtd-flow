/**
 * Чистое ядро пространств (namespaces) GTD Flow.
 *
 * Гибрид «пространство = папка»: набор {name, root}. Принадлежность файла —
 * самый ДЛИННЫЙ корень-префикс его пути; всё вне корней — встроенное
 * пространство «Общее» (sentinel DEFAULT_NS). Опциональный frontmatter
 * gtd-namespace ПЕРЕБИВАЕТ папку (файл-исключение, живущий вне своей папки).
 *
 * core/ не импортирует obsidian и НЕ знает о Settings: сюда приходят только
 * скалярные/структурные параметры (список NamespaceDef). Эффективное
 * пространство считается ЛЕНИВО, в момент фильтрации (зависит от списка
 * корней-настройки), а не хранится на Task. См. scripts/check-core-purity.mjs.
 */

/** Определение пользовательского пространства: имя → корневая папка. */
export interface NamespaceDef {
	/** Отображаемое имя (уникальное). Служит и идентификатором пространства. */
	name: string;
	/** Корневая папка от корня хранилища. Хвостовой «/» нормализуется прочь. */
	root: string;
}

/**
 * Sentinel встроенного пространства «Общее» — всё, что вне пользовательских
 * корней и без frontmatter-override. Стабильная константа с ведущим NUL: не
 * может совпасть ни с одним именем, которое пользователь способен ввести
 * (отображение «Общее» — забота UI, не ядра). Персистится как activeNamespace.
 */
export const DEFAULT_NS = String.fromCharCode(0) + "default";

/**
 * Sentinel «Все пространства» — прозрачный агрегат, показывающий задачи и события
 * ВСЕХ пространств сразу. Отдельная вкладка ТОЛЬКО календаря (проп allowAll у
 * переключателя): по дизайну «Все» имеет смысл лишь там, где сведение всех
 * пространств в один вид полезно (общий календарь). Как DEFAULT_NS — стабильная
 * константа с ведущим NUL, недостижимая вводом с клавиатуры. Фильтр с active ===
 * ALL_NS прозрачен (inNamespace/eventVisibleInNamespace возвращают true всегда).
 */
export const ALL_NS = String.fromCharCode(0) + "all";

/**
 * Активное пространство + список определений — параметр фильтрации запросов.
 * Пустой defs ⇒ пространств не настроено ⇒ всё в DEFAULT_NS ⇒ фильтр прозрачен
 * (обратная совместимость: поведение до появления пространств). active === ALL_NS
 * ⇒ фильтр тоже прозрачен (вкладка «Все» календаря).
 */
export interface NamespaceFilter {
	active: string;
	defs: readonly NamespaceDef[];
}

/**
 * Нормализация пути: trim + срез хвостовых «/». Корень хранилища ("" или "/")
 * → "". Внутренние сегменты и регистр не трогаем (пути безопасны к кириллице —
 * сравнение идёт по code unit'ам JS-строки).
 */
export function normalizeNsPath(path: string): string {
	let s = path.trim();
	while (s.length > 0 && s.endsWith("/")) s = s.slice(0, -1);
	return s;
}

/** Нормализация имени/override: не-строка или пусто после trim → null. */
function normalizeNsName(raw: string | null | undefined): string | null {
	if (typeof raw !== "string") return null;
	const s = raw.trim();
	return s === "" ? null : s;
}

/**
 * Пространство файла (дизайн пользователя):
 *  1) непустой nsOverride (frontmatter gtd-namespace) ПЕРЕБИВАЕТ папку;
 *  2) иначе — имя пространства с самым ДЛИННЫМ корнем-префиксом пути
 *     (root === path || path начинается с root + "/" — совпадение по границе
 *     сегмента: root "Work" НЕ матчит "Workspace/x.md");
 *  3) иначе — DEFAULT_NS («Общее»).
 * Пустой/корневой ("" или "/") root не выделяет пространство. Пустой defs ⇒
 * всегда DEFAULT_NS (кроме явного override).
 */
export function resolveNamespace(
	filePath: string,
	nsOverride: string | null | undefined,
	defs: readonly NamespaceDef[],
): string {
	const override = normalizeNsName(nsOverride);
	if (override !== null) return override;

	const path = normalizeNsPath(filePath);
	let bestName: string | null = null;
	let bestLen = -1;
	for (const d of defs) {
		const root = normalizeNsPath(d.root);
		if (root === "") continue; // корневой root не выделяет пространство
		if (path === root || path.startsWith(root + "/")) {
			if (root.length > bestLen) {
				bestLen = root.length;
				bestName = d.name;
			}
		}
	}
	return bestName ?? DEFAULT_NS;
}

/**
 * Корневая папка пространства по имени (нормализованная), либо null, если имя
 * не найдено среди defs (в т.ч. DEFAULT_NS — у «Общего» корня нет).
 */
export function nsRoot(name: string, defs: readonly NamespaceDef[]): string | null {
	for (const d of defs) if (d.name === name) return normalizeNsPath(d.root);
	return null;
}

/**
 * Предикат членства файла в активном пространстве фильтра. Прозрачен (всегда
 * true), когда пространств не настроено (defs пуст) ИЛИ active === ALL_NS
 * (вкладка «Все» календаря) — обратная совместимость и агрегат «все пространства».
 */
export function inNamespace(
	filePath: string,
	nsOverride: string | null | undefined,
	filter: NamespaceFilter,
): boolean {
	if (filter.defs.length === 0) return true;
	if (filter.active === ALL_NS) return true;
	return resolveNamespace(filePath, nsOverride, filter.defs) === filter.active;
}

/**
 * Предикат видимости СОБЫТИЯ (container "events") в календаре фильтра. В отличие
 * от inNamespace, «общие» события (пространство DEFAULT_NS — вне корней) видны в
 * календаре ЛЮБОГО пространства: серия активного ns ∪ серии «Общего». Это касается
 * ТОЛЬКО событий — задачи режутся обычным inNamespace (общие задачи в чужой
 * календарь не протекают). ALL_NS / пустой defs — прозрачен (все события).
 * Дедуп не нужен: множества {активное ns} и {DEFAULT_NS} не пересекаются.
 */
export function eventVisibleInNamespace(
	filePath: string,
	nsOverride: string | null | undefined,
	filter: NamespaceFilter,
): boolean {
	if (filter.defs.length === 0) return true;
	if (filter.active === ALL_NS) return true;
	const ns = resolveNamespace(filePath, nsOverride, filter.defs);
	return ns === filter.active || ns === DEFAULT_NS;
}

/**
 * Нормализация персистнутого активного пространства к валидному значению:
 * DEFAULT_NS всегда валиден; именованное — только если ещё существует среди
 * defs. Иначе (пространство удалили из настроек, а активным осталось оно) —
 * откат к DEFAULT_NS, иначе фильтр резал бы всё в пустоту. Пустой defs ⇒
 * DEFAULT_NS (пространств нет).
 */
export function normalizeActiveNamespace(
	active: string,
	defs: readonly NamespaceDef[],
	allowAll = false,
): string {
	// ALL_NS («Все») валиден только там, где вызыватель разрешил (календарь):
	// глобальный дефолт и не-календарные виды его не принимают (откат к «Общему»).
	if (allowAll && active === ALL_NS) return ALL_NS;
	if (active === DEFAULT_NS) return DEFAULT_NS;
	return defs.some((d) => d.name === active) ? active : DEFAULT_NS;
}

// ---------------------------------------------------------------------------
// Цели создания файлов по конвенции пространства (дизайн пользователя)
// ---------------------------------------------------------------------------

/**
 * Конвенция имён файлов/папок ВНУТРИ корня пространства (дизайн). Именованное
 * пространство кладёт эти файлы под свой root; «Общее» (DEFAULT_NS) — под
 * `commonRoot` (см. nsCommonTarget): захват → <commonRoot>/Входящие.md и т.д.
 * Часть целей «Общего» всё ещё берётся из выделенных настроек (eventsFile,
 * archiveFile, spawnTarget) — их вызыватель подставляет как fallback в nsTargetPath.
 * Это доменная константа, НЕ настройка: ядру можно (кириллица в путях безопасна —
 * сравнение по code unit'ам).
 */
export const NS_CONVENTION = {
	/** Фолбэк-цель захвата и spawn-target именованного пространства. */
	inbox: "Входящие.md",
	/** Файл серий-событий именованного пространства. */
	events: "События.md",
	/** Файл-приёмник архивирования именованного пространства. */
	archive: "Архив.md",
	/** Фолбэк-файл шаблонов регулярных именованного пространства. */
	recurring: "Регулярные.md",
	/** Каталог новых досок именованного пространства. */
	boardsDir: "Доски",
	/** Каталог новых проектов именованного пространства. */
	projectsDir: "Проекты",
} as const;

/**
 * Целевой путь по конвенции пространства: для ИМЕНОВАННОГО пространства (root
 * найден и непуст) — `<root>/<suffix>`; для «Общего»/неизвестного имени (root
 * === null или "") — fallback (существующая глобальная настройка). suffix — имя
 * файла или папки из NS_CONVENTION. Настроек ядро не знает: fallback приходит
 * снаружи (образец inboxIncludePlain → InboxConfig). Применяется там, где у
 * «Общего» есть ВЫДЕЛЕННАЯ настройка-цель (eventsFile, archiveFile, spawnTarget);
 * где её нет (захват — после выпила inboxSources) — nsCommonTarget.
 */
export function nsTargetPath(
	name: string,
	defs: readonly NamespaceDef[],
	suffix: string,
	fallback: string,
): string {
	const root = nsRoot(name, defs);
	if (root === null || root === "") return fallback;
	return `${root}/${suffix}`;
}

/**
 * Целевой путь, где «Общее» СТОИТ В ОДИН РЯД с именованными: у именованного
 * пространства (root найден и непуст) — `<root>/<suffix>`; у «Общего»/неизвестного
 * имени — `<commonRoot>/<suffix>` (commonRoot — «дом» создаваемых файлов «Общего»,
 * настройка commonRoot). Пустой commonRoot ⇒ голый suffix (файл в корне хранилища).
 *
 * Отличие от nsTargetPath: 4-й параметр — не готовый fallback-ПУТЬ, а КОРНЕВАЯ ПАПКА
 * «Общего», к которой сам дописывается suffix. Применять там, где у «Общего» нет
 * выделенной настройки-цели: захват (быстрый ввод / фолбэк spawn) после выпила
 * inboxSources → <commonRoot>/Входящие.md. Настроек ядро не знает — commonRoot
 * приходит снаружи (settings.commonRoot).
 */
export function nsCommonTarget(
	name: string,
	defs: readonly NamespaceDef[],
	suffix: string,
	commonRoot: string,
): string {
	const named = nsRoot(name, defs);
	const root = named === null || named === "" ? normalizeNsPath(commonRoot) : named;
	return root === "" ? suffix : `${root}/${suffix}`;
}
