import { describe, expect, it } from "vitest";
import { SerializedSettingsSaver } from "./SerializedSettingsSaver";

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
});
