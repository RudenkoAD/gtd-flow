/**
 * ObsidianClock — ClockPort поверх registerInterval. Раз в минуту сравнивает
 * локальную дату с последней увиденной и при смене дня будит подписчиков
 * (тикль/входящие пересчитаются деривацией через bump эпохи в индексаторе).
 */
import type { Plugin } from "obsidian";
import type { IsoDate } from "../core/model/Task";
import { localTodayIso } from "../services/snapshotHelpers";
import type { ClockPort } from "../services/types";

const CHECK_INTERVAL_MS = 60_000;

export class ObsidianClock implements ClockPort {
	private readonly callbacks = new Set<() => void>();
	private lastToday: IsoDate;

	constructor(plugin: Plugin) {
		this.lastToday = localTodayIso(new Date());
		// registerInterval снимает таймер при выгрузке плагина
		plugin.registerInterval(window.setInterval(() => this.check(), CHECK_INTERVAL_MS));
	}

	todayIso(): IsoDate {
		return localTodayIso(new Date());
	}

	onDayRollover(cb: () => void): () => void {
		this.callbacks.add(cb);
		return () => {
			this.callbacks.delete(cb);
		};
	}

	private check(): void {
		const now = localTodayIso(new Date());
		if (now === this.lastToday) return;
		this.lastToday = now;
		for (const cb of [...this.callbacks]) cb();
	}
}
