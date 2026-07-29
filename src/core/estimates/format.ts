import { MINUTES_PER_DAY, type DurationMinutes, type IntensityLevel } from "../model/Task";

export type LongDurationStyle = "whole-days";

export function formatDuration(
	minutes: DurationMinutes | null,
	_longStyle: LongDurationStyle = "whole-days",
): string {
	if (minutes === null) return "Unknown";
	if (minutes >= MINUTES_PER_DAY) return `${minutes / MINUTES_PER_DAY}d`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return [hours > 0 ? `${hours}h` : "", remainder > 0 ? `${remainder}m` : ""]
		.filter(Boolean)
		.join(" ");
}

export const INTENSITY_ANCHORS: Record<
	"cognitive" | "emotional" | "physical",
	Record<IntensityLevel, string>
> = {
	cognitive: {
		0: "Not applicable",
		1: "Routine and nearly automatic",
		2: "Light attention",
		3: "Sustained concentration",
		4: "Complex reasoning",
		5: "Maximum concentration or novel problem solving",
	},
	emotional: {
		0: "Not applicable",
		1: "Emotionally neutral",
		2: "Mild discomfort",
		3: "Meaningful emotional effort",
		4: "Strong resistance or vulnerability",
		5: "Exceptionally difficult emotional load",
	},
	physical: {
		0: "Not applicable",
		1: "Negligible bodily exertion",
		2: "Light physical activity",
		3: "Moderate sustained exertion",
		4: "Hard physical work",
		5: "Maximum safe bodily exertion",
	},
};
