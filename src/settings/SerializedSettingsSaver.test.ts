import { describe, expect, it } from "vitest";
import { runSerializedCompareAndSet, SerializedSettingsSaver } from "./SerializedSettingsSaver";

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
} {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("SerializedSettingsSaver", () => {
	it("persists invocation snapshots in order, so the newest call wins", async () => {
		const firstWrite = deferred();
		const firstStarted = deferred();
		const started: number[] = [];
		let disk = { revision: 0, nested: { value: "initial" } };
		const saver = new SerializedSettingsSaver<typeof disk>(async (snapshot) => {
			started.push(snapshot.revision);
			if (snapshot.revision === 1) {
				firstStarted.resolve();
				await firstWrite.promise;
			}
			disk = snapshot;
		});
		const live = { revision: 1, nested: { value: "first" } };

		const first = saver.save(live);
		live.revision = 2;
		live.nested.value = "second";
		const second = saver.save(live);
		await firstStarted.promise;

		expect(started).toEqual([1]);
		firstWrite.resolve();
		await expect(first).resolves.toEqual({ latest: false });
		await expect(second).resolves.toEqual({ latest: true });
		expect(started).toEqual([1, 2]);
		expect(disk).toEqual({ revision: 2, nested: { value: "second" } });
	});

	it("continues with the next snapshot after a rejected write", async () => {
		let calls = 0;
		let disk = 0;
		const saver = new SerializedSettingsSaver<number>(async (snapshot) => {
			calls++;
			if (calls === 1) throw new Error("disk full");
			disk = snapshot;
		});

		await expect(saver.save(1)).rejects.toThrow("disk full");
		await expect(saver.save(2)).resolves.toEqual({ latest: true });
		expect(disk).toBe(2);
	});

	it("does not identify an older success as publishable when the newest write fails", async () => {
		const firstWrite = deferred();
		let calls = 0;
		const saver = new SerializedSettingsSaver<number>(async () => {
			calls++;
			if (calls === 1) await firstWrite.promise;
			else throw new Error("newest write failed");
		});

		const first = saver.save(1);
		const second = saver.save(2);
		firstWrite.resolve();

		await expect(first).resolves.toEqual({ latest: false });
		await expect(second).rejects.toThrow("newest write failed");
	});

	it("captures a queued ordinary save only after a failed transaction restores live fields", async () => {
		const transactionStarted = deferred();
		const transactionWrite = deferred();
		let calls = 0;
		let disk = { migration: "before", ordinary: 0 };
		const live = { ...disk };
		const saver = new SerializedSettingsSaver<typeof live>(async (snapshot) => {
			calls++;
			if (calls === 1) {
				transactionStarted.resolve();
				await transactionWrite.promise;
			}
			disk = snapshot;
		});

		const transaction = saver.runExclusive(async (persist) => {
			live.migration = "after";
			try {
				await persist(live);
			} catch (error) {
				live.migration = "before";
				throw error;
			}
		});
		const transactionFailure = expect(transaction).rejects.toThrow("migration-save-failed");
		await transactionStarted.promise;

		// This request is made while the speculative value is live. Its lazy
		// snapshot must wait for the transaction's catch to restore that value.
		live.ordinary = 1;
		const ordinary = saver.saveFrom(() => live);
		transactionWrite.reject(new Error("migration-save-failed"));

		await transactionFailure;
		await expect(ordinary).resolves.toEqual({ latest: true });
		expect(disk).toEqual({ migration: "before", ordinary: 1 });
	});

	it("compensates a settings write whose acknowledgement is lost", async () => {
		type State = { migration: string; ordinary: number };
		let calls = 0;
		let disk: State = { migration: "before", ordinary: 0 };
		const live = { ...disk };
		const saver = new SerializedSettingsSaver<State>(async (snapshot) => {
			calls++;
			disk = snapshot; // durable replacement happened
			if (calls === 1) throw new Error("settings-commit-ack-lost");
		});

		const transaction = runSerializedCompareAndSet(saver, {
			read: () => live.migration,
			expected: "before",
			next: "after",
			equal: (left, right) => left === right,
			replace: (value) => {
				live.migration = value;
			},
			restore: (before) => before,
			persistenceSnapshot: () => ({ ...live }),
		});

		await expect(transaction).rejects.toThrow("settings-commit-ack-lost");
		expect(live).toEqual({ migration: "before", ordinary: 0 });
		expect(disk).toEqual({ migration: "before", ordinary: 0 });
		expect(calls).toBe(2);
	});

	it("compensates durably when a compared field changes while the CAS write is pending", async () => {
		type State = {
			migration: { inbox: string; legacy: string };
			ordinary: number;
		};
		const firstStarted = deferred();
		const firstWrite = deferred();
		let calls = 0;
		let disk: State = {
			migration: { inbox: "Old.md", legacy: "legacy-data" },
			ordinary: 0,
		};
		const live = structuredClone(disk);
		const saver = new SerializedSettingsSaver<State>(async (snapshot) => {
			calls++;
			if (calls === 1) {
				firstStarted.resolve();
				await firstWrite.promise;
			}
			disk = snapshot;
		});
		const equal = (left: State["migration"], right: State["migration"]) =>
			left.inbox === right.inbox && left.legacy === right.legacy;
		const expected = structuredClone(live.migration);
		const next = { inbox: "Unified.md", legacy: "" };

		const transaction = runSerializedCompareAndSet(saver, {
			read: () => structuredClone(live.migration),
			expected,
			next,
			equal,
			replace: (value) => {
				live.migration = structuredClone(value);
			},
			restore: (before, speculative, current) => ({
				inbox: current.inbox === speculative.inbox ? before.inbox : current.inbox,
				legacy: current.legacy === speculative.legacy ? before.legacy : current.legacy,
			}),
			persistenceSnapshot: () => structuredClone(live),
		});
		await firstStarted.promise;

		// The user changes a migration-owned field and an unrelated field while
		// the first saveData call is still pending.
		live.migration.inbox = "Custom.md";
		live.ordinary = 1;
		const ordinary = saver.saveFrom(() => live);
		firstWrite.resolve();

		await expect(transaction).resolves.toEqual({ value: false, latest: false });
		await expect(ordinary).resolves.toEqual({ latest: true });
		expect(disk).toEqual({
			migration: { inbox: "Custom.md", legacy: "legacy-data" },
			ordinary: 1,
		});
		expect(calls).toBe(3); // speculative write, compensation, queued ordinary save
	});
});
