import type { GtdViewKind } from "../views/registry";

export interface RuntimeFeaturePolicy {
	readonly desktopAi: boolean;
	readonly crossViewDnd: boolean;
	readonly backgroundPromotion: boolean;
	readonly backgroundCalendarSync: boolean;
	readonly onboarding: boolean;
	readonly recurrence: boolean;
	readonly viewKinds: readonly GtdViewKind[];
}

const ANDROID_MVP_VIEWS = ["inbox", "calendar", "recurring"] as const;

/**
 * The universal bundle has two composition roots. Android deliberately starts
 * only the product slice that has device coverage; desktop keeps the complete
 * pre-existing surface. Recurrence remains a writer on both platforms because
 * its deterministic instance IDs and convergence pass are cross-device safe.
 */
export function runtimeFeaturePolicy(isDesktopApp: boolean): RuntimeFeaturePolicy {
	if (isDesktopApp) {
		return {
			desktopAi: true,
			crossViewDnd: true,
			backgroundPromotion: true,
			backgroundCalendarSync: true,
			onboarding: true,
			recurrence: true,
			viewKinds: [
				"inbox",
				"kanban",
				"calendar",
				"tickler",
				"ai",
				"recurring",
				"projects",
				"project",
			],
		};
	}
	return {
		desktopAi: false,
		crossViewDnd: false,
		backgroundPromotion: false,
		backgroundCalendarSync: false,
		onboarding: false,
		recurrence: true,
		viewKinds: ANDROID_MVP_VIEWS,
	};
}
