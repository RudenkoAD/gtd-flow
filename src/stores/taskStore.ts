/**
 * Svelte-store обёртка над IndexFeed (ТЗ §2): epoch/today — реактивные Readable,
 * сам TaskIndex — через index(): он мутируемый, класть его в store бессмысленно,
 * подписчики реагируют на epoch и перечитывают индекс синхронно.
 */
import { writable, type Readable } from "svelte/store";
import type { TaskIndex } from "../core/index/TaskIndex";
import type { IsoDate } from "../core/model/Task";
import type { IndexFeed } from "../services/types";

export interface TaskStore {
	epoch: Readable<number>;
	today: Readable<IsoDate>;
	index: () => TaskIndex;
	dispose(): void;
}

export function createTaskStore(feed: IndexFeed): TaskStore {
	const epoch = writable(feed.getEpoch());
	const today = writable(feed.today());
	// Один onChange покрывает и правки индекса, и смену дня: epoch монотонный,
	// writable сам глотает set() с неизменившимся примитивом (подписчики молчат).
	let unsubscribe: (() => void) | null = feed.onChange(() => {
		epoch.set(feed.getEpoch());
		today.set(feed.today());
	});
	return {
		epoch: { subscribe: epoch.subscribe },
		today: { subscribe: today.subscribe },
		index: () => feed.getIndex(),
		dispose(): void {
			if (unsubscribe !== null) {
				unsubscribe();
				unsubscribe = null;
			}
		},
	};
}
