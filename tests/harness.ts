/**
 * Shared test harness for workflow package tests.
 * Provides makeStorage, assert, buildWf, copyState helpers.
 */

import { buildContext } from "../src/context";
import type { StateCache } from "../src/context";
import type { EventEntry, RunResult, StepEntry, WorkflowStorage } from "../src/types";

// ── Counters ──────────────────────────────────────────────────────────────────

export let passed = 0;
export let failed = 0;

export function resetCounters() {
	passed = 0;
	failed = 0;
}

export function assert(cond: boolean, msg: string) {
	if (cond) {
		console.log(`  ✓ ${msg}`);
		passed++;
	} else {
		console.error(`  ✗ FAIL: ${msg}`);
		failed++;
	}
}

// ── Storage ───────────────────────────────────────────────────────────────────

export function makeStorage(
	stateStore: Map<number, Record<string, unknown>> = new Map(),
): WorkflowStorage & {
	stateStore: Map<number, Record<string, unknown>>;
} {
	let nextId = 1;
	return {
		stateStore,
		async upsertInstance() {
			return nextId++;
		},
		async createRun(_instance, _run): Promise<RunResult> {
			const instanceId = nextId++;
			const runId = nextId++;
			return { instanceId, runId, deduplicated: false };
		},
		async claimPendingRuns() {
			return [];
		},
		async completeRun() {},
		async failRun() {},
		async suspendRun() {},
		async cancelRun() {},
		async cancelChildren() {},
		async rerunInstance() {
			return nextId++;
		},
		async getInstance() {
			return null;
		},
		async getChildren() {
			return [];
		},
		async getRun() {
			return null;
		},
		async getLatestRun() {
			return null;
		},
		async getRuns() {
			return [];
		},
		async pendingCount() {
			return 0;
		},
		async findRunWaitingForHook(token) {
			// Search all states for an event entry with matching token
			for (const [_runId, state] of stateStore) {
				const events = (state.event ?? {}) as Record<string, EventEntry>;
				for (const entry of Object.values(events)) {
					if (entry.token === token && entry.status === "waiting") {
						return null; // in tests, we don't have the full run object
					}
				}
			}
			return null;
		},
		async deliverHookSignal(runId, token, data) {
			const state = stateStore.get(runId);
			if (!state) return;
			const events = (state.event ?? {}) as Record<string, EventEntry>;
			for (const [key, entry] of Object.entries(events)) {
				if (entry.token === token && entry.status === "waiting") {
					events[key] = { status: "delivered", token, data };
					break;
				}
			}
			state.event = events;
			stateStore.set(runId, { ...state });
		},
		async getState(runId) {
			return stateStore.get(runId) ?? {};
		},
		async setState(runId, state) {
			stateStore.set(runId, { ...state });
		},
	};
}

// ── Context helpers ───────────────────────────────────────────────────────────

/**
 * Build context with state loaded from the stateStore.
 * Simulates what the executor does: load state, pass as stateCache.
 */
export function buildWf(
	runId: number,
	instanceId: number,
	name: string,
	storage: WorkflowStorage & {
		stateStore: Map<number, Record<string, unknown>>;
	},
) {
	const stateCache: StateCache = {
		data: structuredClone(storage.stateStore.get(runId) ?? {}),
	};
	return buildContext(runId, instanceId, name, storage, stateCache);
}

/**
 * Simulate rerun by copying state from one run to another.
 */
export function copyState(stateStore: Map<number, Record<string, unknown>>, fromRunId: number, toRunId: number) {
	const prev = stateStore.get(fromRunId);
	if (prev) stateStore.set(toRunId, structuredClone(prev));
}

/**
 * Helper to seed a step entry in the state store for testing.
 */
export function seedStep(
	stateStore: Map<number, Record<string, unknown>>,
	runId: number,
	stepKey: string,
	entry: StepEntry,
) {
	const state = stateStore.get(runId) ?? {};
	const steps = (state.step ?? {}) as Record<string, StepEntry>;
	steps[stepKey] = entry;
	state.step = steps;
	stateStore.set(runId, state);
}

/**
 * Helper to create a completed step entry for testing.
 */
export function completedStep(result: unknown, seq: number = 1): StepEntry {
	return {
		status: "completed",
		result,
		error: null,
		attempts: 1,
		seq,
		startedAt: new Date().toISOString(),
		completedAt: new Date().toISOString(),
		durationMs: 10,
		replayedAt: null,
	};
}

// ── Summary ───────────────────────────────────────────────────────────────────

export function printSummary() {
	console.log(`\n${"─".repeat(50)}`);
	console.log(`Results: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}
