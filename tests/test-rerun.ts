/**
 * Tests for rerun option on step() and memo().
 */

import type { StepEntry } from "../src/types";
import { assert, buildWf, makeStorage } from "./harness";

export async function run() {
	console.log("\nTest R1: step rerun — re-executes and overwrites cached result");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		let callCount = 0;

		// First execution
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [result] = await wf.step("fetch", async () => {
				callCount++;
				return { v: 1 };
			});
			assert(result.v === 1, "R1: first execution returns v=1");
			assert(callCount === 1, "R1: thunk called once");
		}

		// Second execution with rerun: true
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [result, , fresh] = await wf.step(
				"fetch",
				async () => {
					callCount++;
					return { v: 2 };
				},
				{ rerun: true },
			);
			assert(result.v === 2, "R1: rerun returns fresh v=2");
			assert(fresh === true, "R1: fresh is true on rerun");
			assert(callCount === 2, "R1: thunk called again on rerun");
		}

		// Third execution without rerun — should return cached v=2
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [result, , fresh] = await wf.step("fetch", async () => {
				callCount++;
				return { v: 3 };
			});
			assert(result.v === 2, "R1: cached result is v=2 after rerun");
			assert(fresh === false, "R1: not fresh on replay");
			assert(callCount === 2, "R1: thunk NOT called on replay");
		}
	}

	console.log("\nTest R2: step rerun preserves seq");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		// Create two steps
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			await wf.step("a", async () => "first");
			await wf.step("b", async () => "second");
		}

		// Rerun step "a"
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			await wf.step("a", async () => "updated", { rerun: true });
		}

		const state = stateStore.get(1)!;
		const steps = state.step as Record<string, StepEntry>;
		assert(steps.a.seq === 1, "R2: step a keeps seq=1 after rerun");
		assert(steps.b.seq === 2, "R2: step b keeps seq=2");
	}

	console.log("\nTest R3: memo rerun — re-executes");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		let callCount = 0;

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [result] = await wf.memo("compute", () => {
				callCount++;
				return 42;
			});
			assert(result === 42, "R3: first memo returns 42");
			assert(callCount === 1, "R3: memo fn called once");
		}

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [result, , fresh] = await wf.memo(
				"compute",
				() => {
					callCount++;
					return 99;
				},
				{ rerun: true },
			);
			assert(result === 99, "R3: rerun memo returns 99");
			assert(fresh === true, "R3: fresh on rerun");
			assert(callCount === 2, "R3: memo fn called again");
		}
	}

	console.log("\nTest R4: dependency chain — rerun cascades");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		// First execution
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [a] = await wf.step("fetch", async () => 10);
			const [b] = await wf.step("double", async () => a * 2);
			assert(b === 20, "R4: first run: double = 20");
		}

		// Second execution: rerun fetch → cascade to double
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [a] = await wf.step("fetch", async () => 50, { rerun: true });
			const [b] = await wf.step("double", async () => a * 2, { rerun: true });
			assert(a === 50, "R4: rerun fetch = 50");
			assert(b === 100, "R4: rerun double = 100");
		}
	}

	console.log("\nTest R5: rerun on failed step — re-executes with fresh attempts");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		let attempt = 0;

		// First execution: fails
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			try {
				await wf.step("flaky", async () => {
					attempt++;
					throw new Error("fail");
				});
			} catch {}
		}

		// Verify step is fatal
		{
			const state = stateStore.get(1)!;
			const steps = state.step as Record<string, StepEntry>;
			assert(steps.flaky?.status === "fatal", "R5: step is fatal after exhausting attempts");
		}

		// Rerun: should re-execute with fresh state
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const [result, , fresh] = await wf.step("flaky", async () => {
				attempt++;
				return "recovered";
			}, { rerun: true });
			assert(result === "recovered", "R5: rerun on failed step succeeds");
			assert(fresh === true, "R5: fresh is true");
		}
	}
}
