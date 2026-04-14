/**
 * Tests for waitForEvent() / createHook() — own event bucket.
 */

import { SuspendSignal } from "../src/errors";
import type { EventEntry } from "../src/types";
import { assert, buildWf, makeStorage } from "./harness";

export async function run() {
	console.log("\nTest E1: waitForEvent — stores in event bucket");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(42, 1, "wf", storage);

		let threw: unknown;
		try {
			await wf.waitForEvent("approval");
		} catch (e) {
			threw = e;
		}
		assert(threw instanceof SuspendSignal, "waitForEvent throws SuspendSignal");
		assert((threw as SuspendSignal).reason === "hook", "reason is hook");

		const state = stateStore.get(42)!;
		const events = state.event as Record<string, EventEntry>;
		assert(events["42:approval"]?.status === "waiting", "event entry is waiting");
		assert(events["42:approval"]?.token === "42:approval", "token is runId:eventName");

		// Step bucket should not exist
		assert(state.step === undefined, "no step bucket created for events");
	}

	console.log("\nTest E2: waitForEvent — delivers data on replay");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		// First: register event
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(42, 1, "wf", storage);
			try {
				await wf.waitForEvent("approval");
			} catch {}
		}

		// Simulate signal delivery
		{
			const state = stateStore.get(42)!;
			const events = state.event as Record<string, EventEntry>;
			events["42:approval"] = { status: "delivered", token: "42:approval", data: { approved: true, by: "admin" } };
			state.event = events;
			stateStore.set(42, state);
		}

		// Replay: data is available
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(42, 1, "wf", storage);
			const result = await wf.waitForEvent<{ approved: boolean; by: string }>("approval");
			assert(result.approved === true, "delivered data: approved is true");
			assert(result.by === "admin", "delivered data: by is admin");
		}
	}

	console.log("\nTest E3: multiple events are independent");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		// Register two events
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(10, 1, "wf", storage);

		try {
			await wf.waitForEvent("step-1");
		} catch {}

		// Deliver first event
		{
			const state = stateStore.get(10)!;
			const events = state.event as Record<string, EventEntry>;
			events["10:step-1"] = { status: "delivered", token: "10:step-1", data: "done" };
			state.event = events;
			stateStore.set(10, state);
		}

		// Rebuild context — first event should return, second should suspend
		{
			const storage2 = makeStorage(stateStore);
			const { wf: wf2 } = buildWf(10, 1, "wf", storage2);
			const result1 = await wf2.waitForEvent<string>("step-1");
			assert(result1 === "done", "first event delivered correctly");

			let threw: unknown;
			try {
				await wf2.waitForEvent("step-2");
			} catch (e) {
				threw = e;
			}
			assert(threw instanceof SuspendSignal, "second event still suspends");
		}
	}

	console.log("\nTest E4: deliverHookSignal via storage");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);

		// Register event
		const { wf } = buildWf(99, 1, "wf", storage);
		try {
			await wf.waitForEvent("confirm");
		} catch {}

		// Deliver via storage method
		await storage.deliverHookSignal(99, "99:confirm", { confirmed: true });

		// Check state was updated
		const state = stateStore.get(99)!;
		const events = state.event as Record<string, EventEntry>;
		assert(events["99:confirm"]?.status === "delivered", "storage delivered event");
		assert((events["99:confirm"]?.data as any)?.confirmed === true, "storage delivered correct data");

		// Rebuild and read
		const storage2 = makeStorage(stateStore);
		const { wf: wf2 } = buildWf(99, 1, "wf", storage2);
		const result = await wf2.waitForEvent<{ confirmed: boolean }>("confirm");
		assert(result.confirmed === true, "event data accessible after storage delivery");
	}
}
