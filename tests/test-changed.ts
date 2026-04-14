/**
 * Tests for changed() — uses rawState("changed", label).
 * Values are stored as native JSONB, not serialized strings.
 */

import { assert, buildWf, copyState, makeStorage } from "./harness";

export async function run() {
	console.log("\nTest C1: changed() — first call returns true");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		const result = await wf.changed("price", 100);
		assert(result === true, "C1: first call returns true");
	}

	console.log("\nTest C2: changed() — same value returns false");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		await wf.changed("price", 100);
		const result = await wf.changed("price", 100);
		assert(result === false, "C2: same value returns false");
	}

	console.log("\nTest C3: changed() — different value returns true");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		await wf.changed("price", 100);
		const result = await wf.changed("price", 200);
		assert(result === true, "C3: different value returns true");
	}

	console.log("\nTest C4: changed() — object key order doesn't matter");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		await wf.changed("data", { a: 1, b: 2 });
		const result = await wf.changed("data", { b: 2, a: 1 });
		assert(result === false, "C4: key order doesn't matter");
	}

	console.log("\nTest C5: changed() — array order matters");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		await wf.changed("list", [1, 2]);
		const result = await wf.changed("list", [2, 1]);
		assert(result === true, "C5: array order matters");
	}

	console.log("\nTest C6: changed() — multiple labels independent");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		await wf.changed("a", 10);
		await wf.changed("b", 20);

		const ra = await wf.changed("a", 10);
		const rb = await wf.changed("b", 30);
		assert(ra === false, "C6: label 'a' unchanged");
		assert(rb === true, "C6: label 'b' changed");
	}

	console.log("\nTest C7: changed() — stores native value, not JSON string");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		await wf.changed("listing", { price: 100, zip: "10115" });

		const state = stateStore.get(1)!;
		const changed = state.changed as Record<string, unknown>;
		assert(typeof changed.listing === "object", "C7: stored as native object");
		assert((changed.listing as any).price === 100, "C7: price is native number");
		assert(typeof changed.listing !== "string", "C7: NOT stored as JSON string");
	}

	console.log("\nTest C8: changed() — survives across executions (via copyState)");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		// Execution 1: set value
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			await wf.changed("color", "blue");
		}

		// Copy state (simulates retrigger)
		copyState(stateStore, 1, 2);

		// Execution 2: same value → unchanged
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(2, 1, "wf", storage);
			const result = await wf.changed("color", "blue");
			assert(result === false, "C8: unchanged across executions");
		}

		// Copy state again
		copyState(stateStore, 2, 3);

		// Execution 3: different value → changed
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(3, 1, "wf", storage);
			const result = await wf.changed("color", "red");
			assert(result === true, "C8: detected change across executions");
		}
	}

	console.log("\nTest C9: changed() — handles primitives");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		await wf.changed("str", "hello");
		assert((await wf.changed("str", "hello")) === false, "C9: string unchanged");
		assert((await wf.changed("str", "world")) === true, "C9: string changed");

		await wf.changed("num", 42);
		assert((await wf.changed("num", 42)) === false, "C9: number unchanged");

		await wf.changed("bool", true);
		assert((await wf.changed("bool", true)) === false, "C9: bool unchanged");
		assert((await wf.changed("bool", false)) === true, "C9: bool changed");

		await wf.changed("nil", null);
		assert((await wf.changed("nil", null)) === false, "C9: null unchanged");
	}

	console.log("\nTest C10: changed() — nested objects");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		const obj = { a: { b: { c: 1 } }, d: [1, 2, 3] };
		await wf.changed("deep", obj);
		assert((await wf.changed("deep", { a: { b: { c: 1 } }, d: [1, 2, 3] })) === false, "C10: deep equal");
		assert((await wf.changed("deep", { a: { b: { c: 2 } }, d: [1, 2, 3] })) === true, "C10: deep changed");
	}
}
