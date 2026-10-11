/**
 * Tests for retry backoff strategies and step timeouts.
 */

import { computeBackoffMs } from "../src/backoff";
import { StepTimeoutError } from "../src/errors";
import type { StepEntry } from "../src/types";
import { assert, buildWf, makeStorage } from "./harness";

export async function run() {
	console.log("\nTest B1: computeBackoffMs — none strategy");
	assert(computeBackoffMs("none", 1) === 1000, "B1: none attempt 1 = 1000ms");
	assert(computeBackoffMs("none", 5) === 1000, "B1: none attempt 5 = 1000ms");

	console.log("\nTest B2: computeBackoffMs — linear strategy");
	assert(computeBackoffMs("linear", 1) === 1000, "B2: linear attempt 1 = 1000ms");
	assert(computeBackoffMs("linear", 2) === 2000, "B2: linear attempt 2 = 2000ms");
	assert(computeBackoffMs("linear", 5) === 5000, "B2: linear attempt 5 = 5000ms");

	console.log("\nTest B3: computeBackoffMs — exponential strategy");
	assert(computeBackoffMs("exponential", 1) === 1000, "B3: exp attempt 1 = 1000ms");
	assert(computeBackoffMs("exponential", 2) === 2000, "B3: exp attempt 2 = 2000ms");
	assert(computeBackoffMs("exponential", 3) === 4000, "B3: exp attempt 3 = 4000ms");
	assert(computeBackoffMs("exponential", 4) === 8000, "B3: exp attempt 4 = 8000ms");

	console.log("\nTest B4: step timeout — times out and records failure");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		let threw: unknown;
		try {
			await wf.step(
				"slow",
				async () => {
					await new Promise((r) => setTimeout(r, 5000));
					return "never";
				},
				{ timeout: 50, maxAttempts: 2 },
			);
		} catch (e) {
			threw = e;
		}
		assert(threw instanceof StepTimeoutError, "B4: StepTimeoutError thrown");
		const state = stateStore.get(1)!;
		const steps = state.step as Record<string, StepEntry>;
		assert(steps.slow?.status === "failed", "B4: step recorded as failed (retry available)");
		assert(steps.slow?.error?.includes("timed out") === true, "B4: error mentions timeout");
	}

	console.log("\nTest B5: step timeout — exhausts attempts → fatal");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		let threw: unknown;
		try {
			await wf.step(
				"slow-fatal",
				async () => {
					await new Promise((r) => setTimeout(r, 5000));
					return "never";
				},
				{ timeout: 50, maxAttempts: 1 },
			);
		} catch (e) {
			threw = e;
		}
		assert(threw !== undefined, "B5: error thrown");
		const state = stateStore.get(1)!;
		const steps = state.step as Record<string, StepEntry>;
		assert(steps["slow-fatal"]?.status === "fatal", "B5: step is fatal (maxAttempts=1)");
	}

	console.log("\nTest B6: step timeout — duration string");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		let threw: unknown;
		try {
			await wf.step(
				"slow-str",
				async () => {
					await new Promise((r) => setTimeout(r, 5000));
					return "never";
				},
				{ timeout: "50ms", maxAttempts: 2 },
			);
		} catch (e) {
			threw = e;
		}
		assert(threw instanceof StepTimeoutError, "B6: timeout with duration string works");
	}

	console.log("\nTest B7: retry then success on second execution");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		let callCount = 0;

		// First execution: fails
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			try {
				await wf.step(
					"retry-me",
					async () => {
						callCount++;
						throw new Error("fail");
					},
					{ maxAttempts: 3 },
				);
			} catch {}
		}

		assert(callCount === 1, "B7: thunk called once in first execution");

		// Verify step is failed with attempts=1
		{
			const state = stateStore.get(1)!;
			const steps = state.step as Record<string, StepEntry>;
			assert(steps["retry-me"]?.status === "failed", "B7: step is failed");
			assert(steps["retry-me"]?.attempts === 1, "B7: attempts is 1");
		}

		// Second execution (simulates wake from backoff sleep): succeeds
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [result, err, fresh] = await wf.step(
				"retry-me",
				async () => {
					callCount++;
					return "success";
				},
				{ maxAttempts: 3 },
			);
			assert(result === "success", "B7: second attempt succeeds");
			assert(err === null, "B7: no error on success");
			assert(fresh === true, "B7: fresh on successful retry");
			assert(callCount === 2, "B7: thunk called twice total");
		}
	}

	console.log("\nTest B8: onAllAttemptsFailed: 'complete' on replay of fatal step");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		// First execution: exhaust all attempts
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			await wf.step(
				"fail-open-replay",
				async () => {
					throw new Error("always fails");
				},
				{ onAllAttemptsFailed: "complete" },
			);
		}

		// Replay: should return null + error without executing thunk
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			let thunkCalled = false;
			const [data, err, fresh] = await wf.step(
				"fail-open-replay",
				async () => {
					thunkCalled = true;
					return "should not run";
				},
				{ onAllAttemptsFailed: "complete" },
			);
			assert(data === null, "B8: data is null on replay of fatal step");
			assert(err !== null, "B8: error returned on replay");
			assert(fresh === false, "B8: not fresh on replay");
			assert(!thunkCalled, "B8: thunk NOT called on replay of fatal step");
		}
	}
}
