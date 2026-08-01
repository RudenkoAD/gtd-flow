import { describe, expect, it, vi } from "vitest";
import type { TaskEstimateProvenance } from "../../core/estimates/provenance";
import { createScopeCatalog } from "../../core/scope/scope";
import { makeTask } from "../../stores/testSupport";
import type { TaskDetailsChanges } from "./taskDetails";
import {
	ATOMIC_TASK_UPDATE_UNAVAILABLE_REASON,
	applyTaskDetailsChanges,
	dispatchTaskDetailsIntents,
	type TaskMenuCtx,
	type TaskMetadataPort,
} from "./taskMenu";

const task = makeTask({
	key: "id:atomic-details",
	taskId: "atomic-details",
	filePath: "Inbox.md",
	description: "Atomic details",
});

const ordinaryIntents: TaskDetailsChanges["ordinaryIntents"] = [
	{ type: "set-text", key: task.key, text: "Updated details" },
	{ type: "set-priority", key: task.key, priority: "high" },
];

function context(
	dispatcher: TaskMenuCtx["dispatcher"],
	metadata: TaskMetadataPort | null = null,
): TaskMenuCtx {
	return {
		task,
		app: {} as TaskMenuCtx["app"],
		dispatcher,
		settings: {} as TaskMenuCtx["settings"],
		today: "2026-08-02",
		ports: metadata === null ? null : { metadata },
	};
}

function metadataPort(applyManualUpdate: TaskMetadataPort["applyManualUpdate"]): TaskMetadataPort {
	return {
		scopes: () => createScopeCatalog(),
		scopeName: () => null,
		provenanceForTask: async () => null as TaskEstimateProvenance | null,
		applyManualPatch: async () => ({ ok: true }),
		applyManualUpdate,
	};
}

describe("task details atomic integration", () => {
	it("fails closed instead of dispatching a multi-intent update sequentially", async () => {
		const dispatch = vi.fn(async () => ({ ok: true as const }));

		await expect(dispatchTaskDetailsIntents({ dispatch }, ordinaryIntents)).resolves.toEqual({
			ok: false,
			reason: ATOMIC_TASK_UPDATE_UNAVAILABLE_REASON,
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("permits one ordinary intent without a batch port", async () => {
		const dispatch = vi.fn(async () => ({ ok: true as const }));

		await expect(
			dispatchTaskDetailsIntents({ dispatch }, [ordinaryIntents[0]!]),
		).resolves.toEqual({
			ok: true,
		});
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch).toHaveBeenCalledWith(ordinaryIntents[0]);
	});

	it("uses one batch call when multiple ordinary intents can be applied atomically", async () => {
		const dispatch = vi.fn(async () => ({ ok: true as const }));
		const dispatchMany = vi.fn(async () => ({ ok: true as const }));
		const dispatcher = { dispatch, dispatchMany };

		await expect(dispatchTaskDetailsIntents(dispatcher, ordinaryIntents)).resolves.toEqual({
			ok: true,
		});
		expect(dispatchMany).toHaveBeenCalledOnce();
		expect(dispatchMany).toHaveBeenCalledWith(ordinaryIntents);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("routes even ordinary-only saves through an available metadata update port", async () => {
		const dispatch = vi.fn(async () => ({ ok: true as const }));
		const applyManualUpdate = vi.fn(async () => ({ ok: true as const }));
		const changes: TaskDetailsChanges = {
			ordinaryIntents,
			metadataPatch: {},
		};

		await expect(
			applyTaskDetailsChanges(
				context({ dispatch }, metadataPort(applyManualUpdate)),
				changes,
			),
		).resolves.toEqual({ ok: true });
		expect(applyManualUpdate).toHaveBeenCalledOnce();
		expect(applyManualUpdate).toHaveBeenCalledWith(
			task,
			ordinaryIntents,
			changes.metadataPatch,
		);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("rejects metadata changes when no metadata service is available", async () => {
		const dispatch = vi.fn(async () => ({ ok: true as const }));

		await expect(
			applyTaskDetailsChanges(context({ dispatch }), {
				ordinaryIntents: [ordinaryIntents[0]!],
				metadataPatch: { scopeId: "work" },
			}),
		).resolves.toEqual({ ok: false, reason: "task-metadata-unavailable" });
		expect(dispatch).not.toHaveBeenCalled();
	});
});
