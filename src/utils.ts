import type { EventEntry, SleepEntry, StepEntry } from "./types";

/**
 * Extract step entries from the execution state blob.
 * Returns sorted by seq (ascending).
 */
export function extractSteps(state: Record<string, unknown>): (StepEntry & { stepKey: string })[] {
	const bucket = (state.step ?? {}) as Record<string, StepEntry>;
	return Object.entries(bucket)
		.map(([stepKey, entry]) => ({ stepKey, ...entry }))
		.sort((a, b) => a.seq - b.seq);
}

/**
 * Extract memo entries from the execution state blob.
 */
export function extractMemos(state: Record<string, unknown>): { key: string; value: unknown }[] {
	const bucket = (state.memo ?? {}) as Record<string, unknown>;
	return Object.entries(bucket).map(([key, value]) => ({ key, value }));
}

/**
 * Extract sleep entries from the execution state blob.
 */
export function extractSleeps(state: Record<string, unknown>): (SleepEntry & { key: string })[] {
	const bucket = (state.sleep ?? {}) as Record<string, SleepEntry>;
	return Object.entries(bucket).map(([key, entry]) => ({ key, ...entry }));
}

/**
 * Extract event entries from the execution state blob.
 */
export function extractEvents(state: Record<string, unknown>): (EventEntry & { key: string })[] {
	const bucket = (state.event ?? {}) as Record<string, EventEntry>;
	return Object.entries(bucket).map(([key, entry]) => ({ key, ...entry }));
}
