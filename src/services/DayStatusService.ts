/**
 * DayStatusService — обнаружение, чтение и правка файла статусов дней
 * (`gtd-day-status: true`) для покраски календаря. Обёртка вокруг чистого ядра
 * core/daystatus: тут только IO (vault/metadata) и реактивный store модели.
 *
 * Зависимости внедряются (как в BoardService/CardService) — сервис не импортит
 * obsidian напрямую; события подписываются в main.ts через onVaultChange.
 */
import { writable, type Readable, type Writable } from "svelte/store";
import type { IsoDate } from "../core/model/Task";
import {
	EMPTY_DAY_STATUS_MODEL,
	buildDayStatusModel,
	clearSingleDayBody,
	setRangeBody,
	setSingleDayBody,
	statusForDate,
	withEditedBody,
	type DayStatusModel,
} from "../core/daystatus/dayStatus";

export interface DayStatusDeps {
	/** Путь файла-носителя `gtd-day-status: true` или null (обратная карта frontmatter). */
	discoverFile: () => string | null;
	readFrontmatter: (path: string) => Record<string, unknown> | null;
	readFile: (path: string) => Promise<string | null>;
	processFile: (path: string, transform: (content: string) => string | null) => Promise<boolean>;
	ensureFile: (path: string) => Promise<void>;
	processFrontmatter: (path: string, fn: (fm: Record<string, unknown>) => void) => Promise<void>;
	/** Путь для создания файла статусов, если его ещё нет (settings.dayStatusFile). */
	defaultFilePath: () => string;
	/** Подписка на изменения vault/metadata — колбэк должен звать refresh. */
	onVaultChange: (cb: () => void) => void;
}

/** Стартовая палитра при создании файла статусов (пользователь потом правит). */
const STARTER_STATUSES: Record<string, string> = {
	работаю: "#4c8bf5",
	учусь: "#9c27b0",
	"в командировке": "#e5892a",
	выходной: "#4caf50",
};

/** Порт для видов календаря: модель, палитра статусов и правки. */
export interface DayStatusPort {
	model: Readable<DayStatusModel>;
	/** Определённые статусы (имя+цвет) текущей модели — для меню покраски. */
	statuses: () => { name: string; color: string }[];
	/** Статус конкретной даты (имя+цвет) или null. */
	statusOf: (date: IsoDate) => { name: string; color: string } | null;
	/** Есть ли файл статусов (иначе меню предлагает создать). */
	hasConfig: () => boolean;
	/** Создать файл статусов со стартовой палитрой, если его нет. */
	ensureConfig: () => Promise<void>;
	setDay: (date: IsoDate, status: string) => Promise<void>;
	clearDay: (date: IsoDate) => Promise<void>;
	setRange: (from: IsoDate, to: IsoDate, status: string) => Promise<void>;
	/** Upsert определения статуса (имя→цвет) во frontmatter-карте statuses. */
	setStatusDef: (name: string, color: string) => Promise<void>;
	/** Удалить определение статуса из frontmatter-карты statuses. */
	removeStatusDef: (name: string) => Promise<void>;
}

/** Привести значение frontmatter.statuses к простой карте имя→строка-цвет. */
function coerceStatusMap(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof v === "string") out[k] = v;
		}
	}
	return out;
}

export class DayStatusService implements DayStatusPort {
	private readonly model$: Writable<DayStatusModel> = writable(EMPTY_DAY_STATUS_MODEL);
	private current: DayStatusModel = EMPTY_DAY_STATUS_MODEL;
	private path: string | null = null;

	constructor(private readonly deps: DayStatusDeps) {}

	get model(): Readable<DayStatusModel> {
		return { subscribe: this.model$.subscribe };
	}

	/** Только подписки. Первичный refresh зовёт main.ts ПОСЛЕ резолва кэша:
	 *  findByFrontmatterValue строит обратный индекс лениво и кэширует — вызванный
	 *  до резолва, он навсегда закэшировал бы пустой индекс (события 'changed'
	 *  правят его лишь инкрементально, 'resolved' — не перестраивает). */
	start(): void {
		this.deps.onVaultChange(() => void this.refresh());
	}

	/** Текущий путь файла статусов (для gate событий в main.ts). */
	filePath(): string | null {
		return this.path;
	}

	hasConfig(): boolean {
		return this.deps.discoverFile() !== null;
	}

	statuses(): { name: string; color: string }[] {
		return [...this.current.defs].map(([name, color]) => ({ name, color }));
	}

	statusOf(date: IsoDate): { name: string; color: string } | null {
		return statusForDate(this.current, date);
	}

	async refresh(): Promise<void> {
		const path = this.deps.discoverFile();
		this.path = path;
		if (path === null) {
			this.set(EMPTY_DAY_STATUS_MODEL);
			return;
		}
		const fm = this.deps.readFrontmatter(path);
		const content = await this.deps.readFile(path);
		this.set(buildDayStatusModel(fm?.["statuses"], content ?? ""));
	}

	async ensureConfig(): Promise<void> {
		await this.ensureTargetFile();
		await this.refresh();
	}

	async setDay(date: IsoDate, status: string): Promise<void> {
		const path = await this.ensureTargetFile();
		await this.deps.processFile(path, (c) => withEditedBody(c, (b) => setSingleDayBody(b, date, status)));
		await this.refresh();
	}

	async clearDay(date: IsoDate): Promise<void> {
		const path = this.deps.discoverFile();
		if (path === null) return;
		await this.deps.processFile(path, (c) => withEditedBody(c, (b) => clearSingleDayBody(b, date)));
		await this.refresh();
	}

	async setRange(from: IsoDate, to: IsoDate, status: string): Promise<void> {
		const path = await this.ensureTargetFile();
		await this.deps.processFile(path, (c) => withEditedBody(c, (b) => setRangeBody(b, from, to, status)));
		await this.refresh();
	}

	async setStatusDef(name: string, color: string): Promise<void> {
		const key = name.trim();
		if (key === "") return;
		const path = await this.ensureTargetFile();
		await this.deps.processFrontmatter(path, (fm) => {
			const statuses = coerceStatusMap(fm["statuses"]);
			statuses[key] = color;
			fm["statuses"] = statuses;
		});
		await this.refresh();
	}

	async removeStatusDef(name: string): Promise<void> {
		const key = name.trim();
		if (key === "") return;
		const path = await this.ensureTargetFile();
		await this.deps.processFrontmatter(path, (fm) => {
			const statuses = coerceStatusMap(fm["statuses"]);
			delete statuses[key];
			fm["statuses"] = statuses;
		});
		await this.refresh();
	}

	private set(model: DayStatusModel): void {
		this.current = model;
		this.model$.set(model);
	}

	/** Гарантирует файл статусов; создаёт со стартовой палитрой, если его нет. */
	private async ensureTargetFile(): Promise<string> {
		const existing = this.deps.discoverFile();
		if (existing !== null) return existing;
		const path = this.deps.defaultFilePath();
		await this.deps.ensureFile(path);
		await this.deps.processFrontmatter(path, (fm) => {
			fm["gtd-day-status"] = true;
			if (fm["statuses"] === undefined) fm["statuses"] = { ...STARTER_STATUSES };
		});
		this.path = path;
		return path;
	}
}
