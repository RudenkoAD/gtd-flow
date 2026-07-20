/**
 * Диф задач одного файла по ключам (ТЗ §2) — питает инкрементальное
 * обновление индекса и адресные уведомления подписчиков.
 */
import type { Task } from "../model/Task";

export interface TaskChange {
	before: Task;
	after: Task;
}

export interface FileDiff {
	added: Task[];
	removed: Task[];
	changed: TaskChange[];
}

/**
 * Сравнение старого и нового парса файла по task.key.
 * «Изменение» = тот же key, но другой rawLine: сдвиг строки без правки
 * текста изменением НЕ считается (номера строк — только подсказка, ТЗ §2).
 *
 * Дубли ключей (две одинаковые id-less строки или один 🆔 дважды в файле)
 * детерминированно уникализируются суффиксом \u0001N — та же схема, что в
 * TaskIndex.insert: иначе Map.set терял бы первого близнеца и правка одного
 * из них не попадала бы в уведомления об изменениях.
 */
export function diffFile(oldTasks: readonly Task[], newTasks: readonly Task[]): FileDiff {
	const olds = uniquifyKeys(oldTasks);
	const news = uniquifyKeys(newTasks);
	const oldByKey = new Map<string, Task>();
	for (const t of olds) oldByKey.set(t.key, t);

	const added: Task[] = [];
	const changed: TaskChange[] = [];
	const newKeys = new Set<string>();
	for (const t of news) {
		newKeys.add(t.key);
		const prev = oldByKey.get(t.key);
		if (prev === undefined) added.push(t);
		else if (prev.rawLine !== t.rawLine) changed.push({ before: prev, after: t });
	}
	const removed = olds.filter((t) => !newKeys.has(t.key));
	return { added, removed, changed };
}

/**
 * Уникализация ключей ВНУТРИ одного парса (порядок строк файла стабилен, значит
 * i-й близнец получает одинаковый суффикс в старом и новом парсе). Задачи с
 * уникальными ключами возвращаются как есть.
 */
function uniquifyKeys(tasks: readonly Task[]): readonly Task[] {
	const seen = new Set<string>();
	let hasDup = false;
	for (const t of tasks) {
		if (seen.has(t.key)) {
			hasDup = true;
			break;
		}
		seen.add(t.key);
	}
	if (!hasDup) return tasks;
	const used = new Set<string>();
	return tasks.map((t) => {
		let sk = t.key;
		let n = 1;
		while (used.has(sk)) sk = t.key + "\u0001" + n++;
		used.add(sk);
		return sk === t.key ? t : { ...t, key: sk };
	});
}
