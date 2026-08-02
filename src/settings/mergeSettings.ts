/**
 * Версионированная граница для data.json.
 *
 * Настройки редактируются и самим плагином, и вручную.  Поэтому загрузчик не
 * имеет права делать небезопасный cast произвольного JSON к GtdFlowSettings:
 * одна строка вместо настроек прежних пространств не должна ломать загрузку.
 * Здесь каждая известная ветка проверяется Zod-схемой отдельно, чтобы битое
 * поле не отбрасывало корректные соседние настройки. Числовые значения
 * нормализуются в те же границы, что и UI, а не передаются в setTimeout/циклы
 * как бесконтрольные значения.
 */
import { type ZodType, z } from "../schema/zod";
import { readLegacyNamespaceSettings } from "../core/scope/namespaceMigration";
import { SETTINGS_FORMAT_VERSION, type GtdFlowSettings } from "./Settings";

type JsonObject = Record<string, unknown>;

const MAX_PATH_LENGTH = 1024;
const MAX_TEXT_LENGTH = 4096;
const MAX_SUBSCRIPTIONS = 200;
const MAX_PRESETS = 200;
const MAX_RETRIES = 10_000;

const boundedString = (max = MAX_TEXT_LENGTH) => z.string().max(max);
const trimmedString = (max = MAX_TEXT_LENGTH) => boundedString(max).trim();
const nonEmptyString = (max = MAX_TEXT_LENGTH) => trimmedString(max).min(1);
const pathString = (allowEmpty = true) =>
	(allowEmpty ? trimmedString(MAX_PATH_LENGTH) : nonEmptyString(MAX_PATH_LENGTH)).refine(
		(value) => !value.includes("\u0000"),
		"must not contain a NUL character",
	);

/** UI вводит только целые числа в этих границах; старые ручные значения
 * приводим к ближайшей допустимой границе вместо того, чтобы отдавать их
 * таймерам/циклам без лимита. */
const clampedInt = (min: number, max: number) =>
	z
		.number()
		.finite()
		.int()
		.transform((value) => Math.max(min, Math.min(max, value)));

const calendarFieldSchema = z.enum(["due", "scheduled", "start"]);
const calendarPlacementSchema = z
	.array(calendarFieldSchema)
	.length(3)
	.refine((fields) => new Set(fields).size === 3, "must contain each calendar field once");

const deferPresetSchema = z.object({
	label: nonEmptyString(256),
	offsetDays: clampedInt(0, 36_500),
});

const promotionRetrySchema = z.object({
	taskId: nonEmptyString(512),
	source: nonEmptyString(MAX_PATH_LENGTH),
	target: pathString(false).nullable(),
});

function isCalendarUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "webcal:";
	} catch {
		return false;
	}
}

const externalCalendarSchema = z.object({
	id: nonEmptyString(256),
	name: trimmedString(256),
	url: nonEmptyString(MAX_TEXT_LENGTH).refine(isCalendarUrl, "must be an http(s) or webcal URL"),
	lastSyncAt: z.number().finite().int().min(0).nullable(),
	lastError: boundedString(2048).nullable(),
});

const debounceSchema = z.object({
	fileReindex: clampedInt(0, 10_000),
	queryRecompute: clampedInt(0, 10_000),
});

const recurringSchema = z.object({
	catchUp: z.enum(["latest", "all", "none"]),
	catchUpCap: clampedInt(1, 1_000),
});

const aiSchema = z.object({
	enabled: z.boolean(),
	privacyPolicy: z.enum(["unconfigured", "account-policy", "require-zdr"]),
	credentialStorage: z.enum(["unconfigured", "memory-only"]),
	storageVersion: clampedInt(0, 1_000),
});
const durationLongStyleSchema = z.literal("whole-days");

const statusMapSchema = z
	.record(z.string().max(64), boundedString(256))
	.refine((map) => Object.keys(map).length <= 100, "must contain at most 100 entries");

/**
 * Формальная схема известного формата. Она экспортирована и для read-only
 * интеграций (MCP/виджет), но merge ниже валидирует поля по отдельности, чтобы
 * частично повреждённый JSON восстанавливался предсказуемо.
 */
export const PersistedSettingsSchema = z
	.object({
		settingsVersion: z.number().finite().int().min(0),
		inboxFile: pathString(false),
		ai: aiSchema.partial(),
		durationLongStyle: durationLongStyleSchema,
		inboxIncludePlain: z.boolean(),
		projectStrategy: z.enum(["tag", "folder"]),
		projectTagPrefix: boundedString(512),
		calendarPlacement: calendarPlacementSchema,
		deferPresets: z.array(deferPresetSchema).max(MAX_PRESETS),
		firstDayOfWeek: clampedInt(0, 6),
		statusMap: statusMapSchema,
		defaultBoardPath: pathString(),
		autoInjectId: z.boolean(),
		debounceMs: debounceSchema.partial(),
		virtualizeThreshold: clampedInt(0, 100_000),
		promoteTo: z.enum(["origin", "inbox"]),
		promoteLastRun: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.nullable(),
		promoteRetries: z.array(promotionRetrySchema).max(MAX_RETRIES),
		recurring: recurringSchema.partial(),
		cardsFolder: pathString(),
		cardLinkInLine: z.boolean(),
		eventsFile: pathString(),
		archiveFile: pathString(),
		dayStatusFile: pathString(),
		onboarded: z.boolean(),
		lastQuickAddKind: z.enum(["task", "event"]),
		externalCalendars: z.array(externalCalendarSchema).max(MAX_SUBSCRIPTIONS),
		externalSyncIntervalMin: clampedInt(1, 1_440),
	})
	.partial()
	.passthrough();

export interface SettingsMergeResult {
	settings: GtdFlowSettings;
	/** Только имена полей/версии, никогда приватные значения (например ICS URL). */
	diagnostics: string[];
}

/**
 * Слить сохранённый JSON с дефолтами. Сигнатура сохранена для существующих
 * callers; потребитель, которому нужна диагностика миграции, может вызвать
 * mergeSettingsWithDiagnostics.
 */
export function mergeSettings(defaults: GtdFlowSettings, loaded: unknown): GtdFlowSettings {
	return mergeSettingsWithDiagnostics(defaults, loaded).settings;
}

export function mergeSettingsWithDiagnostics(
	defaults: GtdFlowSettings,
	loaded: unknown,
): SettingsMergeResult {
	const diagnostics: string[] = [];
	const raw = asObject(loaded);
	if (raw === null) {
		if (loaded !== null && loaded !== undefined)
			diagnostics.push("root: expected object; defaults used");
		return { settings: freshDefaults(defaults), diagnostics };
	}

	const data = migrateToCurrent(raw, diagnostics);
	const settings = freshDefaults(defaults);
	// Неизвестные top-level поля остаются на месте ради forward compatibility,
	// однако опасные prototype-ключи никогда не копируются в живой объект.
	copyUnknownFields(
		settings as unknown as JsonObject,
		data,
		new Set([
			...Object.keys(PersistedSettingsSchema.shape),
			// v1-only fields are consumed by the compatibility reader, never retained
			// in the target runtime settings object or re-serialized data.json.
			"commonRoot",
			"namespaces",
			"activeNamespace",
		]),
	);

	settings.settingsVersion = SETTINGS_FORMAT_VERSION;
	assignIfValid(settings, "inboxFile", pathString(false), data, diagnostics);
	assignIfValid(settings, "durationLongStyle", durationLongStyleSchema, data, diagnostics);
	assignIfValid(settings, "inboxIncludePlain", z.boolean(), data, diagnostics);
	assignIfValid(settings, "projectStrategy", z.enum(["tag", "folder"]), data, diagnostics);
	assignIfValid(settings, "projectTagPrefix", boundedString(512), data, diagnostics);
	assignIfValid(settings, "calendarPlacement", calendarPlacementSchema, data, diagnostics);
	assignIfValid(
		settings,
		"deferPresets",
		z.array(deferPresetSchema).max(MAX_PRESETS),
		data,
		diagnostics,
	);
	assignIfValid(settings, "firstDayOfWeek", clampedInt(0, 6), data, diagnostics);
	assignIfValid(settings, "statusMap", statusMapSchema, data, diagnostics);
	assignIfValid(settings, "defaultBoardPath", pathString(), data, diagnostics);
	assignIfValid(settings, "autoInjectId", z.boolean(), data, diagnostics);
	assignIfValid(settings, "virtualizeThreshold", clampedInt(0, 100_000), data, diagnostics);
	assignIfValid(settings, "promoteTo", z.enum(["origin", "inbox"]), data, diagnostics);
	assignIfValid(
		settings,
		"promoteLastRun",
		z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.nullable(),
		data,
		diagnostics,
	);
	assignIfValid(
		settings,
		"promoteRetries",
		z.array(promotionRetrySchema).max(MAX_RETRIES),
		data,
		diagnostics,
	);
	assignIfValid(settings, "cardsFolder", pathString(), data, diagnostics);
	assignIfValid(settings, "cardLinkInLine", z.boolean(), data, diagnostics);
	assignIfValid(settings, "eventsFile", pathString(), data, diagnostics);
	assignIfValid(settings, "archiveFile", pathString(), data, diagnostics);
	assignIfValid(settings, "dayStatusFile", pathString(), data, diagnostics);
	assignIfValid(settings, "onboarded", z.boolean(), data, diagnostics);
	assignIfValid(settings, "lastQuickAddKind", z.enum(["task", "event"]), data, diagnostics);
	assignIfValid(
		settings,
		"externalCalendars",
		z.array(externalCalendarSchema).max(MAX_SUBSCRIPTIONS),
		data,
		diagnostics,
	);
	assignIfValid(settings, "externalSyncIntervalMin", clampedInt(1, 1_440), data, diagnostics);

	mergeNested(
		settings.ai as unknown as JsonObject,
		data["ai"],
		aiSchema.shape as Record<string, ZodType>,
		"ai",
		diagnostics,
	);
	mergeNested(
		settings.debounceMs as unknown as JsonObject,
		data["debounceMs"],
		debounceSchema.shape as Record<string, ZodType>,
		"debounceMs",
		diagnostics,
	);
	mergeNested(
		settings.recurring as unknown as JsonObject,
		data["recurring"],
		recurringSchema.shape as Record<string, ZodType>,
		"recurring",
		diagnostics,
	);
	return { settings, diagnostics };
}

/** Версия 0 — все текущие legacy data.json без settingsVersion. Пока миграция
 * структурно нейтральна; явная функция предотвращает возврат к неявным casts,
 * когда формат вырастет до v2. Новые сохранения получают v1. */
function migrateToCurrent(raw: JsonObject, diagnostics: string[]): JsonObject {
	const versionResult = z
		.number()
		.finite()
		.int()
		.min(0)
		.safeParse(raw["settingsVersion"] ?? 0);
	const version = versionResult.success ? versionResult.data : 0;
	if (!versionResult.success) diagnostics.push("settingsVersion: invalid; treated as legacy v0");
	if (version > SETTINGS_FORMAT_VERSION) {
		diagnostics.push(
			`settingsVersion: v${version} is newer than supported v${SETTINGS_FORMAT_VERSION}`,
		);
	}
	if (version < SETTINGS_FORMAT_VERSION)
		diagnostics.push(`settings: migrated v${version} → v${SETTINGS_FORMAT_VERSION}`);
	const migrated: JsonObject = { ...raw, settingsVersion: SETTINGS_FORMAT_VERSION };
	if (version < 2 && migrated["inboxFile"] === undefined) {
		const legacy = readLegacyNamespaceSettings(raw);
		const legacySpawn = asObject(raw["recurring"])?.["spawnTarget"];
		if (typeof legacySpawn === "string" && legacySpawn.trim() !== "") {
			migrated["inboxFile"] = legacySpawn;
		} else if (legacy.commonRoot !== null) {
			const root = legacy.commonRoot.replace(/\/+$/u, "");
			migrated["inboxFile"] = root === "" ? "Inbox.md" : `${root}/Inbox.md`;
		}
		diagnostics.push("namespace settings retained only for migration planning");
	}
	const ai = asObject(migrated["ai"]);
	if (ai !== null) {
		const decidedAi = { ...ai };
		if (decidedAi["privacyPolicy"] === "unconfigured") {
			decidedAi["privacyPolicy"] = "account-policy";
			diagnostics.push("ai.privacyPolicy: migrated to account-policy");
		}
		if (decidedAi["credentialStorage"] === "unconfigured") {
			decidedAi["credentialStorage"] = "memory-only";
			diagnostics.push("ai.credentialStorage: migrated to memory-only");
		}
		migrated["ai"] = decidedAi;
	}
	if (
		migrated["durationLongStyle"] === "unconfigured" ||
		migrated["durationLongStyle"] === "total-hours" ||
		migrated["durationLongStyle"] === "days-hours"
	) {
		migrated["durationLongStyle"] = "whole-days";
		diagnostics.push("durationLongStyle: migrated to whole-days");
	}
	return migrated;
}

/** Частичное вложенное обновление: unknown future поля сохраняем, известные
 * применяем только после проверки. */
function mergeNested(
	target: JsonObject,
	raw: unknown,
	shape: Record<string, ZodType>,
	field: string,
	diagnostics: string[],
): void {
	if (raw === undefined) return;
	const record = asObject(raw);
	if (record === null) {
		diagnostics.push(`${field}: expected object; defaults used`);
		return;
	}
	// spawnTarget был runtime-настройкой пространств до v2. Его допускает
	// только compatibility reader выше, но он не должен «просочиться» в
	// settings.recurring через механизм forward compatibility.
	const retiredKeys = field === "recurring" ? ["spawnTarget"] : [];
	copyUnknownFields(target, record, new Set([...Object.keys(shape), ...retiredKeys]));
	for (const [key, child] of Object.entries(shape) as Array<[string, ZodType]>) {
		if (!(key in record)) continue;
		const parsed = child.safeParse(record[key]);
		if (parsed.success) target[key] = parsed.data;
		else diagnostics.push(`${field}.${key}: invalid; default used`);
	}
}

function assignIfValid<T extends keyof GtdFlowSettings>(
	target: GtdFlowSettings,
	field: T,
	schema: ZodType,
	raw: JsonObject,
	diagnostics: string[],
): void {
	if (!(field in raw)) return;
	const parsed = schema.safeParse(raw[field]);
	if (parsed.success) {
		(target as unknown as JsonObject)[field] = parsed.data;
	} else {
		diagnostics.push(`${String(field)}: invalid; default used`);
	}
}

function freshDefaults(defaults: GtdFlowSettings): GtdFlowSettings {
	return {
		...defaults,
		calendarPlacement: [...defaults.calendarPlacement],
		deferPresets: defaults.deferPresets.map((preset) => ({ ...preset })),
		statusMap: { ...defaults.statusMap },
		ai: { ...defaults.ai },
		debounceMs: { ...defaults.debounceMs },
		promoteRetries: defaults.promoteRetries.map((retry) => ({ ...retry })),
		recurring: { ...defaults.recurring },
		externalCalendars: defaults.externalCalendars.map((calendar) => ({ ...calendar })),
	};
}

function asObject(value: unknown): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function copyUnknownFields(
	target: JsonObject,
	source: JsonObject,
	known: ReadonlySet<string>,
): void {
	for (const [key, value] of Object.entries(source)) {
		if (known.has(key) || key === "__proto__" || key === "prototype" || key === "constructor")
			continue;
		target[key] = value;
	}
}
