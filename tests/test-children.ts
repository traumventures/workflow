/**
 * Tests for runChild() / rerunChild()
 */

import { buildContext } from "../src/context";
import type { StateCache } from "../src/context";
import type { ChildDispatcher, RunResult, StepEntry, WorkflowDefinition } from "../src/types";
import { assert, buildWf, makeStorage } from "./harness";

// ── Mock child dispatcher ──────────────────────────────────────────────────

function mockDispatcher(): ChildDispatcher & {
	runCalls: Array<{ name: string; input: unknown; parentRunId?: number }>;
	rerunCalls: number[];
} {
	let nextInstanceId = 100;
	let nextRunId = 200;
	const runCalls: Array<{ name: string; input: unknown; parentRunId?: number }> = [];
	const rerunCalls: number[] = [];
	return {
		runCalls,
		rerunCalls,
		async run(name, input, opts) {
			runCalls.push({ name, input, parentRunId: opts.parentRunId });
			return {
				instanceId: nextInstanceId++,
				runId: nextRunId++,
				deduplicated: false,
			};
		},
		async rerun(instanceId) {
			rerunCalls.push(instanceId);
			return nextRunId++;
		},
	};
}

// ── Mock workflow definition ───────────────────────────────────────────────

const childWorkflow: WorkflowDefinition<{ value: number }, string> = {
	name: "child-wf:1",
	handler: async () => "done",
	run: async () => ({ instanceId: 0, runId: 0, deduplicated: false }),
};

// ── Helper: build context with child dispatcher ────────────────────────────

function buildWfWithChildren(
	runId: number,
	instanceId: number,
	storage: ReturnType<typeof makeStorage>,
	dispatcher: ChildDispatcher,
) {
	const stateCache: StateCache = {
		data: structuredClone(storage.stateStore.get(runId) ?? {}),
	};
	return buildContext(runId, instanceId, "test-wf", storage, stateCache, dispatcher);
}

export async function run() {
	console.log("\n── test-children ──────────────────────────────────────────");

	console.log("\nTest C1: runChild dispatches with auto parentRunId");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const dispatcher = mockDispatcher();
		const { wf } = buildWfWithChildren(1, 1, storage, dispatcher);

		const result = await wf.runChild(childWorkflow, { value: 42 }, {
			instance: { childId: 1 },
			queue: "test",
		});

		assert(result.instanceId === 100, "returns instanceId from dispatcher");
		assert(result.runId === 200, "returns runId from dispatcher");
		assert(result.deduplicated === false, "not deduplicated");
		assert(dispatcher.runCalls.length === 1, "dispatcher.run called once");
		assert(dispatcher.runCalls[0].name === "child-wf:1", "correct workflow name");
		assert((dispatcher.runCalls[0].input as any).value === 42, "correct input");
		assert(dispatcher.runCalls[0].parentRunId === 1, "parentRunId auto-set from current runId");
	}

	console.log("\nTest C2: runChild is durable — replays from step cache");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const dispatcher = mockDispatcher();

		// First call: dispatches
		{
			const { wf } = buildWfWithChildren(1, 1, storage, dispatcher);
			await wf.runChild(childWorkflow, { value: 1 }, {
				instance: { childId: "a" },
			});
		}

		assert(dispatcher.runCalls.length === 1, "first call dispatches");

		// Second call: replays from cache
		{
			const { wf } = buildWfWithChildren(1, 1, storage, dispatcher);
			const result = await wf.runChild(childWorkflow, { value: 1 }, {
				instance: { childId: "a" },
			});
			assert(result.instanceId === 100, "replayed result matches");
			assert(result.runId === 200, "replayed runId matches");
		}

		assert(dispatcher.runCalls.length === 1, "second call does NOT re-dispatch");
	}

	console.log("\nTest C3: runChild step key is deterministic based on instance");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const dispatcher = mockDispatcher();
		const { wf } = buildWfWithChildren(1, 1, storage, dispatcher);

		await wf.runChild(childWorkflow, { value: 1 }, {
			instance: { b: 2, a: 1 },
		});

		// Check the step key in state — should be sorted
		const state = stateStore.get(1)!;
		const steps = state.step as Record<string, StepEntry>;
		const expectedKey = 'child:child-wf:1:{"a":1,"b":2}';
		assert(expectedKey in steps, `step key is deterministic and sorted: ${expectedKey}`);
	}

	console.log("\nTest C4: rerunChild dispatches and is durable");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const dispatcher = mockDispatcher();

		// First call
		{
			const { wf } = buildWfWithChildren(1, 1, storage, dispatcher);
			const newRunId = await wf.rerunChild(42);
			assert(newRunId === 200, "returns new runId");
			assert(dispatcher.rerunCalls.length === 1, "dispatcher.rerun called once");
			assert(dispatcher.rerunCalls[0] === 42, "correct instanceId passed");
		}

		// Replay
		{
			const { wf } = buildWfWithChildren(1, 1, storage, dispatcher);
			const newRunId = await wf.rerunChild(42);
			assert(newRunId === 200, "replayed runId matches");
		}

		assert(dispatcher.rerunCalls.length === 1, "rerun NOT called again on replay");
	}

	console.log("\nTest C5: runChild throws when no dispatcher (test context)");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage); // no dispatcher

		let threw = false;
		try {
			await wf.runChild(childWorkflow, { value: 1 }, { instance: { x: 1 } });
		} catch (e: any) {
			threw = e.message.includes("not available in test context");
		}
		assert(threw, "throws when no dispatcher");
	}

	console.log("\nTest C6: multiple runChild calls with different instances");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const dispatcher = mockDispatcher();
		const { wf } = buildWfWithChildren(1, 1, storage, dispatcher);

		const r1 = await wf.runChild(childWorkflow, { value: 1 }, { instance: { id: 1 } });
		const r2 = await wf.runChild(childWorkflow, { value: 2 }, { instance: { id: 2 } });

		assert(r1.instanceId === 100, "first child instanceId");
		assert(r2.instanceId === 101, "second child instanceId");
		assert(dispatcher.runCalls.length === 2, "two dispatches");
		assert(dispatcher.runCalls[0].parentRunId === 1, "both have parentRunId=1");
		assert(dispatcher.runCalls[1].parentRunId === 1, "both have parentRunId=1");
	}
}
