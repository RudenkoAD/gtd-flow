/**
 * In-memory индекс задач (ТЗ §2): primary Map + byFile/byId/byDate/byTag.
 * byId — МУЛЬТИЗНАЧНЫЙ: несколько носителей одного 🆔 терпимы и видимы
 * (питают дедуп §8, fail-closed depsMet §1 и lint-бейджи).
 *
 * Коллизия ключей: два носителя одного 🆔 в разных файлах оба получают
 * key вида "id:<🆔>". Терять носителей нельзя (fail-closed проверкам нужны
 * ВСЕ), поэтому второй и далее хранятся под уникализированным ключом
 * `<key>\u0001<n>`, и хранимая КОПИЯ задачи получает этот key — инвариант
 * get(t.key) === t сохраняется для всего, что отдаёт индекс.
 */
import type { IsoDate, Task } from "../model/Task";
import { computeKey } from "../parser/taskKey";

function addToSetMap(map: Map<string, Set<string>>, mk: string, v: string): void {
	const set = map.get(mk);
	if (set) set.add(v);
	else map.set(mk, new Set([v]));
}

function deleteFromSetMap(map: Map<string, Set<string>>, mk: string, v: string): void {
	const set = map.get(mk);
	if (!set) return;
	set.delete(v);
	if (set.size === 0) map.delete(mk);
}

export class TaskIndex {
	private primary = new Map<string, Task>();
	private byFile = new Map<string, Set<string>>();
	private byId = new Map<string, string[]>();
	/** Объединённый бакет по due/scheduled/start (календарю нужен union). */
	private byDate = new Map<IsoDate, Set<string>>();
	private byTag = new Map<string, Set<string>>();
	private epochCounter = 0;

	/** Инкрементируется при КАЖДОЙ мутации — ключ мемоизации запросов. */
	get epoch(): number {
		return this.epochCounter;
	}

	/** Полная замена задач файла (единица инкрементального обновления). */
	replaceFile(path: string, tasks: readonly Task[]): void {
		this.clearFile(path);
		for (const t of tasks) this.insert(path, t);
		this.epochCounter++;
	}

	removeFile(path: string): void {
		this.clearFile(path);
		this.epochCounter++;
	}

	/**
	 * Переименование файла: content-ключи включают путь и перезаписываются
	 * на новый путь; "id:<🆔>" от пути не зависит и стабилен.
	 */
	renameFile(oldPath: string, newPath: string): void {
		const keys = this.byFile.get(oldPath);
		const moved: Task[] = [];
		if (keys) {
			for (const sk of keys) {
				const t = this.primary.get(sk);
				if (t) moved.push(t);
			}
		}
		this.clearFile(oldPath);
		for (const t of moved) {
			const relocated: Task = { ...t, filePath: newPath };
			// Content-ключ переписываем чисто по префиксу пути: хвост
			// <hash>#<occurrenceIndex> назначен индексатором и обязан выжить —
			// computeKey(relocated) с дефолтным occurrenceIndex=0 схлопнул бы
			// одинаковые строки без 🆔 в рукотворную коллизию (уникализация
			// даст ключи вида `<key><U+0001><n>`, которых свежий парс файла никогда не выдаст).
			const key =
				t.taskId === null && t.key.startsWith(oldPath + "#")
					? newPath + t.key.slice(oldPath.length)
					: computeKey(relocated); // id-ключи и неканонические — как раньше
			this.insert(newPath, { ...relocated, key });
		}
		this.epochCounter++;
	}

	get(key: string): Task | undefined {
		return this.primary.get(key);
	}

	/** ВСЕ носители id — для depsMet (fail-closed при дублях) и дедупа. */
	resolveDep(id: string): Task[] {
		const keys = this.byId.get(id);
		if (!keys) return [];
		const out: Task[] = [];
		for (const sk of keys) {
			const t = this.primary.get(sk);
			if (t) out.push(t);
		}
		return out;
	}

	all(): Iterable<Task> {
		return this.primary.values();
	}

	/** 🆔 с более чем одним носителем → их ключи (для lint-бейджей и дедупа §8). */
	duplicateIds(): Map<string, string[]> {
		const dup = new Map<string, string[]>();
		for (const [id, keys] of this.byId) {
			if (keys.length > 1) dup.set(id, [...keys]);
		}
		return dup;
	}

	// --- дополнительные аксессоры (нужны сервисам и видам) ---

	fileTasks(path: string): Task[] {
		return this.collect(this.byFile.get(path));
	}

	dateTasks(date: IsoDate): Task[] {
		return this.collect(this.byDate.get(date));
	}

	tagTasks(tag: string): Task[] {
		return this.collect(this.byTag.get(tag));
	}

	// --- внутренности ---

	private collect(keys: ReadonlySet<string> | undefined): Task[] {
		if (!keys) return [];
		const out: Task[] = [];
		for (const sk of keys) {
			const t = this.primary.get(sk);
			if (t) out.push(t);
		}
		return out;
	}

	private insert(path: string, task: Task): void {
		let sk = task.key;
		let n = 1;
		while (this.primary.has(sk)) sk = task.key + "\u0001" + n++;
		// самосогласованность: хранимая задача всегда несёт свой фактический ключ
		const stored = sk === task.key ? task : { ...task, key: sk };
		this.primary.set(sk, stored);
		addToSetMap(this.byFile, path, sk);
		if (stored.taskId !== null) {
			const list = this.byId.get(stored.taskId);
			if (list) list.push(sk);
			else this.byId.set(stored.taskId, [sk]);
		}
		for (const d of [stored.due, stored.scheduled, stored.start]) {
			if (d !== null) addToSetMap(this.byDate, d, sk);
		}
		for (const tag of stored.tags) addToSetMap(this.byTag, tag, sk);
	}

	private clearFile(path: string): void {
		const keys = this.byFile.get(path);
		if (!keys) return;
		this.byFile.delete(path);
		for (const sk of keys) this.removeStorageKey(sk);
	}

	private removeStorageKey(sk: string): void {
		const task = this.primary.get(sk);
		if (!task) return;
		this.primary.delete(sk);
		if (task.taskId !== null) {
			const list = this.byId.get(task.taskId);
			if (list) {
				const filtered = list.filter((k) => k !== sk);
				if (filtered.length > 0) this.byId.set(task.taskId, filtered);
				else this.byId.delete(task.taskId);
			}
		}
		for (const d of [task.due, task.scheduled, task.start]) {
			if (d !== null) deleteFromSetMap(this.byDate, d, sk);
		}
		for (const tag of task.tags) deleteFromSetMap(this.byTag, tag, sk);
	}
}
