/**
 * Tests: parseDuration, step memoization, sleep suspension/replay,
 * FatalError, retry logic, maxAttempts default, onAllAttemptsFailed,
 * SuspendSignal propagation, createHook.
 */

import { buildContext } from "../src/context";
import { parseDuration } from "../src/duration";
import { FatalError, RetryableError, SuspendSignal } from "../src/errors";
import type { StepEntry } from "../src/types";
import { assert, buildWf, completedStep, makeStorage, seedStep } from "./harness";

export async function run() {
	console.log("\nTest 1: parseDuration");
	assert(parseDuration("7d") === 604800000, "7d = 604800000ms");
	assert(parseDuration("30s") === 30000, "30s = 30000ms");
	assert(parseDuration("1h") === 3600000, "1h = 3600000ms");
	assert(parseDuration("2m") === 120000, "2m = 120000ms");
	try {
		parseDuration("bad");
		assert(false, "bad should throw");
	} catch (e) {
		assert(e instanceof Error, "bad throws Error");
	}
	assert(parseDuration("500ms") === 500, "500ms = 500ms");
	assert(parseDuration("1w") === 604800000, "1w = 604800000ms");

	console.log("\nTest 2: step() memoization — thunk only called once");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		let callCount = 0;

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [result1, err1, fresh1] = await wf.step("fetch", async () => {
				callCount++;
				return { value: 42 };
			});
			assert(result1.value === 42, "first execution returns correct value");
			assert(err1 === null, "no error on first execution");
			assert(fresh1 === true, "fresh on first execution");
			assert(callCount === 1, "thunk called once on first execution");
		}

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [result2, err2, fresh2] = await wf.step("fetch", async () => {
				callCount++;
				return { value: 99 }; // would be wrong value if executed
			});
			assert(result2.value === 42, "replay returns stored value");
			assert(err2 === null, "no error on replay");
			assert(fresh2 === false, "not fresh on replay (cached)");
			assert(callCount === 1, "thunk NOT called on replay");
		}
	}

	console.log("\nTest 3: sleep() — suspends on first call, returns on replay");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			let threw: unknown;
			try {
				await wf.waitForDuration("5s");
			} catch (e) {
				threw = e;
			}
			assert(threw instanceof SuspendSignal, "sleep() throws SuspendSignal on first call");
			assert((threw as SuspendSignal).reason === "sleep", "SuspendSignal reason is 'sleep'");
			// Sleep key is now just "0" (counter-based, no __sleep: prefix)
			assert((threw as SuspendSignal).stepKey === "0", "step key is '0'");
			// Verify sleep entry in state
			const state = stateStore.get(1)!;
			const sleeps = state.sleep as Record<string, { wakeAt: string }>;
			assert(sleeps["0"] !== undefined, "sleep entry stored in state.sleep bucket");
			assert(typeof sleeps["0"].wakeAt === "string", "sleep entry has wakeAt");
		}

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			let threw = false;
			try {
				await wf.waitForDuration("5s");
			} catch {
				threw = true;
			}
			assert(!threw, "sleep() does NOT throw on replay");
		}
	}

	console.log("\nTest 3b: replay handles completed step with undefined result");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [res1, err1, fresh1] = await wf.memo("void-memo", async () => {});
			assert(res1 === undefined, "first execution returns undefined");
			assert(err1 === null, "no error on first execution");
			assert(fresh1 === true, "fresh on first execution");
		}

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [res2, err2, fresh2] = await wf.memo("void-memo", async () => "should-not-run");
			assert(res2 === undefined, "replay returns undefined for void memo");
			assert(err2 === null, "no error on replay");
			assert(fresh2 === false, "not fresh on replay");
		}
	}

	console.log("\nTest 4: step() — FatalError kills execution immediately");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		let threw: unknown;
		try {
			await wf.step("fatal", async () => {
				throw new FatalError("boom");
			});
		} catch (e) {
			threw = e;
		}
		assert(threw instanceof FatalError, "FatalError propagated from step");
		// Step should be recorded as fatal in state
		const state = stateStore.get(1)!;
		const steps = state.step as Record<string, StepEntry>;
		assert(steps.fatal?.status === "fatal", "step stored as fatal in state");
	}

	console.log("\nTest 5: step() — retry on transient error");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		let threw: unknown;
		try {
			await wf.step(
				"flaky",
				async () => {
					throw new Error("transient");
				},
				{ maxAttempts: 3 },
			);
		} catch (e) {
			threw = e;
		}
		assert(threw instanceof Error, "transient error rethrown for executor");
		const state = stateStore.get(1)!;
		const steps = state.step as Record<string, StepEntry>;
		assert(steps.flaky?.status === "failed", "step stored as failed (not fatal) with retries remaining");
		assert(steps.flaky?.attempts === 1, "attempt count is 1 after first failure");
	}

	console.log("\nTest 6: step() — maxAttempts default is 1 (no retry)");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		let threw: unknown;
		try {
			await wf.step("no-retry", async () => {
				throw new Error("once");
			});
		} catch (e) {
			threw = e;
		}
		assert(threw instanceof FatalError, "default maxAttempts=1 → FatalError on first failure");
		const state = stateStore.get(1)!;
		const steps = state.step as Record<string, StepEntry>;
		assert(steps["no-retry"]?.status === "fatal", "step stored as fatal");
	}

	console.log("\nTest 7: step() — onAllAttemptsFailed: 'complete' returns null+error");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		const [data, err, fresh] = await wf.step(
			"fail-open",
			async () => {
				throw new Error("fail");
			},
			{ onAllAttemptsFailed: "complete" },
		);
		assert(data === null, "data is null on fail-open");
		assert(typeof err === "string" && err.includes("fail"), "error message returned");
		assert(fresh === true, "fresh is true (thunk executed)");
	}

	console.log("\nTest 8: SuspendSignal propagates through step()");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		let threw: unknown;
		try {
			await wf.step("suspend-step", async () => {
				throw new SuspendSignal("sleep", "2099-01-01T00:00:00.000Z", "test");
			});
		} catch (e) {
			threw = e;
		}
		assert(threw instanceof SuspendSignal, "SuspendSignal propagates through step");
	}

	console.log("\nTest 9: waitForEvent — suspends, then replays with delivered data");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		// First pass: register event → suspend
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			let threw: unknown;
			try {
				await wf.waitForEvent("approval");
			} catch (e) {
				threw = e;
			}
			assert(threw instanceof SuspendSignal, "waitForEvent throws SuspendSignal");
			assert((threw as SuspendSignal).reason === "hook", "reason is hook");
			// Verify event entry in state
			const state = stateStore.get(1)!;
			const events = state.event as Record<string, { status: string; token: string }>;
			assert(events["1:approval"]?.status === "waiting", "event stored as waiting");
		}

		// Simulate signal delivery
		{
			const state = stateStore.get(1)!;
			const events = state.event as Record<string, { status: string; token: string; data?: unknown }>;
			events["1:approval"] = { status: "delivered", token: "1:approval", data: { approved: true } };
			state.event = events;
			stateStore.set(1, state);
		}

		// Second pass: event data is available
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const result = await wf.waitForEvent<{ approved: boolean }>("approval");
			assert(result.approved === true, "waitForEvent returns delivered data on replay");
		}
	}

	console.log("\nTest 10: step() — result stored as native value, not JSON string");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		await wf.step("native", async () => ({ id: 1, tags: ["a", "b"] }));

		const state = stateStore.get(1)!;
		const steps = state.step as Record<string, StepEntry>;
		const entry = steps.native;
		assert(typeof entry.result === "object", "result is a native object, not a string");
		assert((entry.result as any).id === 1, "result.id is 1");
		assert(Array.isArray((entry.result as any).tags), "result.tags is an array");
	}

	console.log("\nTest 11: memo() — stores raw value in memo bucket, not step bucket");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		const [result] = await wf.memo("shuffle", () => [3, 1, 2]);

		assert(JSON.stringify(result) === "[3,1,2]", "memo returns correct value");

		const state = stateStore.get(1)!;
		const memos = state.memo as Record<string, unknown>;
		assert(JSON.stringify(memos.shuffle) === "[3,1,2]", "memo stored in memo bucket as raw value");
		const steps = (state.step ?? {}) as Record<string, unknown>;
		assert(steps.shuffle === undefined, "memo NOT stored in step bucket");
	}

	console.log("\nTest 12: waitForEvent — uses event bucket");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(42, 1, "wf", storage);
			let threw: unknown;
			try {
				await wf.waitForEvent("approval");
			} catch (e) {
				threw = e;
			}
			assert(threw instanceof SuspendSignal, "waitForEvent throws SuspendSignal");
			const state = stateStore.get(42)!;
			const events = state.event as Record<string, { status: string; token: string }>;
			assert(events["42:approval"]?.status === "waiting", "event stored with auto-generated token");
			assert(events["42:approval"]?.token === "42:approval", "token is runId:eventName");
		}
	}
}
