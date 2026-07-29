import { describe, expect, it } from "vitest";
import {
	eligibleRateLimitedRuns,
	nextQueuedRun,
	recoverableRuns,
	retryDelayMs,
	transitionRun,
} from "./ProcessingQueue";
import {
	DurationMinutesSchema,
	TaskIntensitySchema,
	createInboxProcessingResultSchema,
} from "./processingSchemas";

describe("inbox processing schemas", () => {
	it("accepts five-minute sub-day durations and whole days", () => {
		const largestWholeDay = Math.floor(Number.MAX_SAFE_INTEGER / 1_440) * 1_440;
		for (const value of [5, 90, 1_435, 1_440, 2_880, largestWholeDay]) {
			expect(DurationMinutesSchema.safeParse(value).success).toBe(true);
		}
		for (const value of [0, -5, 7, 2.5, 1_445, 2_220, Number.MAX_SAFE_INTEGER + 5]) {
			expect(DurationMinutesSchema.safeParse(value).success).toBe(false);
		}
	});

	it("requires every intensity dimension and an active scope ID", () => {
		expect(
			TaskIntensitySchema.safeParse({ cognitive: 0, emotional: 5, physical: 3 }).success,
		).toBe(true);
		expect(TaskIntensitySchema.safeParse({ cognitive: 0, emotional: 5 }).success).toBe(false);
		const schema = createInboxProcessingResultSchema(new Set(["work"]));
		const input = {
			tasks: [
				{
					taskId: "task-1",
					durationMinutes: null,
					intensity: { cognitive: 1, emotional: 2, physical: 0 },
					scopeId: "work",
					confidence: {
						duration: 0.1,
						cognitive: 0.2,
						emotional: 0.3,
						physical: 0.4,
						scope: 1,
					},
					questions: [
						{ id: "q-1", text: "Which invoice?", affectedFields: ["duration"] },
					],
				},
			],
		};
		expect(schema.safeParse(input).success).toBe(true);
		expect(
			schema.safeParse({ ...input, tasks: [{ ...input.tasks[0], scopeId: "archived" }] })
				.success,
		).toBe(false);
	});
});

describe("processing queue", () => {
	const queued = {
		id: "run-1",
		state: "queued" as const,
		createdAt: "2026-07-28T12:00:00.000Z",
		updatedAt: "2026-07-28T12:00:00.000Z",
		nextEligibleAt: null,
		attempt: 0,
	};

	it("enforces transitions, attempts, and durable waiting eligibility", () => {
		const processing = transitionRun(queued, "processing", "2026-07-28T12:01:00.000Z");
		expect(processing.attempt).toBe(1);
		const limited = transitionRun(processing, "rate_limited", "2026-07-28T12:02:00.000Z", {
			nextEligibleAt: "2026-07-28T12:05:00.000Z",
		});
		expect(eligibleRateLimitedRuns([limited], "2026-07-28T12:04:59.000Z")).toEqual([]);
		expect(eligibleRateLimitedRuns([limited], "2026-07-28T12:05:00.000Z")).toEqual([limited]);
		expect(transitionRun(limited, "superseded", "2026-07-28T12:06:00.000Z").state).toBe(
			"superseded",
		);
		const retryWaiting = transitionRun(
			processing,
			"retry_waiting",
			"2026-07-28T12:02:00.000Z",
			{ nextEligibleAt: "2026-07-28T12:03:00.000Z" },
		);
		expect(eligibleRateLimitedRuns([retryWaiting], "2026-07-28T12:03:00.000Z")).toEqual([
			retryWaiting,
		]);
		expect(() => transitionRun(queued, "completed", "2026-07-28T12:01:00.000Z")).toThrow();
	});

	it("applies bounded jittered exponential backoff", () => {
		expect(retryDelayMs(0, () => 0, 1_000)).toBe(500);
		expect(retryDelayMs(20, () => 1, 1_000, 10_000)).toBe(10_000);
	});

	it("orders and unlocks durable work by timestamp instants, including offsets", () => {
		const earlierWithOffset = {
			...queued,
			id: "offset",
			createdAt: "2026-07-28T01:00:00+02:00",
			updatedAt: "2026-07-28T01:00:00+02:00",
		};
		const laterUtc = {
			...queued,
			id: "utc",
			createdAt: "2026-07-28T00:00:00Z",
			updatedAt: "2026-07-28T00:00:00Z",
		};
		expect(nextQueuedRun([laterUtc, earlierWithOffset])?.id).toBe("offset");
		expect(
			recoverableRuns(
				[laterUtc, earlierWithOffset],
				"2026-07-28T00:30:00Z",
				"2026-07-28T00:30:00Z",
			).map((run) => run.id),
		).toEqual(["offset", "utc"]);

		const offsetLimited = {
			...earlierWithOffset,
			state: "rate_limited" as const,
			nextEligibleAt: "2026-07-28T01:30:00+02:00",
		};
		expect(eligibleRateLimitedRuns([offsetLimited], "2026-07-28T00:00:00Z")).toEqual([
			offsetLimited,
		]);
	});
});
