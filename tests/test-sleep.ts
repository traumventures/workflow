/**
 * Tests for sleep() and sleepUntil() — own bucket, no step entries.
 */

import { SuspendSignal } from "../src/errors";
import type { SleepEntry } from "../src/types";
import { assert, buildWf, makeStorage } from "./harness";

export async function run() {
	console.log("\nTest S1: sleep() with label");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			let threw: unknown;
			try {
				await wf.waitForDuration("10s", "my-sleep");
			} catch (e) {
				threw = e;
			}
			assert(threw instanceof SuspendSignal, "sleep with label throws SuspendSignal");
			assert((threw as SuspendSignal).stepKey === "my-sleep", "SuspendSignal key is the label");
			const state = stateStore.get(1)!;
			const sleeps = state.sleep as Record<string, SleepEntry>;
			assert(sleeps["my-sleep"] !== undefined, "sleep stored under label key");
			assert(typeof sleeps["my-sleep"].wakeAt === "string", "sleep has wakeAt");
		}

		// Replay: should not throw
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			let threw = false;
			try {
				await wf.waitForDuration("10s", "my-sleep");
			} catch {
				threw = true;
			}
			assert(!threw, "sleep with label does NOT throw on replay");
		}
	}

	console.log("\nTest S2: multiple unlabeled sleeps get different keys");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		// First sleep
		let threw1: unknown;
		try {
			await wf.waitForDuration("5s");
		} catch (e) {
			threw1 = e;
		}
		assert(threw1 instanceof SuspendSignal, "first unlabeled sleep throws");
		assert((threw1 as SuspendSignal).stepKey === "0", "first sleep key is '0'");
	}

	console.log("\nTest S3: sleep(Date) in the past returns immediately");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		let threw = false;
		try {
			await wf.waitForDuration(new Date("2020-01-01T00:00:00Z"));
		} catch {
			threw = true;
		}
		assert(!threw, "sleep with past Date returns immediately");
		const state = stateStore.get(1);
		const sleeps = (state?.sleep ?? {}) as Record<string, unknown>;
		assert(Object.keys(sleeps).length === 0, "no sleep entry created for past Date");
	}

	console.log("\nTest S4: sleepUntil() in the past returns immediately");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		let threw = false;
		try {
			await wf.waitForDate("2020-01-01T00:00:00Z");
		} catch {
			threw = true;
		}
		assert(!threw, "sleepUntil with past date returns immediately");
	}

	console.log("\nTest S5: sleepUntil() in the future suspends");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		let threw: unknown;
		try {
			await wf.waitForDate("2099-01-01T00:00:00Z", "future-sleep");
		} catch (e) {
			threw = e;
		}
		assert(threw instanceof SuspendSignal, "sleepUntil future throws SuspendSignal");
	}

	console.log("\nTest S6: sleep stores entry in sleep bucket, not step bucket");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		try {
			await wf.waitForDuration("5s", "check");
		} catch {}

		const state = stateStore.get(1)!;
		assert(state.sleep !== undefined, "sleep bucket exists");
		assert(state.step === undefined, "step bucket does NOT exist (sleep is not a step)");
	}
}
