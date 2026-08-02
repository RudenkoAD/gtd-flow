import {
	array,
	boolean,
	discriminatedUnion,
	enum as enumSchema,
	literal,
	number,
	object,
	record,
	string,
	union,
	unknown as unknownSchema,
} from "zod/v4";

/**
 * Deliberately small Zod value surface. Importing the top-level `z` namespace
 * makes every locale observable to the bundler; named constructors let
 * tree-shaking retain only schemas used by the plugin.
 */
export const z = {
	array,
	boolean,
	discriminatedUnion,
	enum: enumSchema,
	literal,
	number,
	object,
	record,
	string,
	union,
	unknown: unknownSchema,
} as const;

export type { infer as Infer, input as Input, output as Output, ZodType } from "zod/v4";
