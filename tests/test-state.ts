/**
 * Tests for state(), diff(), kv() — all built on rawState().
 */

import { assert, buildWf, copyState, makeStorage } from "./harness";

export async function run() {
	console.log("\nTest 36: state() — basic get/set");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);
		const counter = wf.state<number>("counter");

		assert(counter.get() === undefined, "T36: initial state is undefined");
		await counter.set(42);
		assert(counter.get() === 42, "T36: state is 42 after set");
		await counter.set(100);
		assert(counter.get() === 100, "T36: state is 100 after second set");
		// Verify it's in the "state" bucket
		const state = stateStore.get(1)!;
		const stateBucket = state.state as Record<string, unknown>;
		assert(stateBucket?.counter === 100, "T36: persisted in state bucket");
	}

	console.log("\nTest 37: state() — survives across executions");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const color = wf.state<string>("color");
			await color.set("blue");
			assert(color.get() === "blue", "T37: color is blue in exec 1");
		}

		copyState(stateStore, 1, 2);

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(2, 1, "wf", storage);
			const color = wf.state<string>("color");
			assert(color.get() === "blue", "T37: color survives to exec 2 as 'blue'");
		}
	}

	console.log("\nTest 38: state() — complex objects");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		const data = wf.state<{ items: number[]; nested: { ok: boolean } }>("data");
		await data.set({ items: [1, 2, 3], nested: { ok: true } });

		const val = data.get();
		assert(val !== undefined, "T38: complex object is defined");
		assert(JSON.stringify(val!.items) === JSON.stringify([1, 2, 3]), "T38: items array preserved");
		assert(val!.nested.ok === true, "T38: nested.ok is true");
	}

	console.log("\nTest 39: state() — multiple independent keys");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		const a = wf.state<number>("a");
		const b = wf.state<string>("b");

		await a.set(10);
		await b.set("hello");
		assert(a.get() === 10, "T39: a is 10");
		assert(b.get() === "hello", "T39: b is 'hello'");

		await a.set(20);
		assert(a.get() === 20, "T39: a updated to 20");
		assert(b.get() === "hello", "T39: b unchanged after a update");
	}

	console.log("\nTest 40: state() — null and special values");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		const n = wf.state<null>("nullVal");
		await n.set(null);
		assert(n.get() === null, "T40: null stored and retrieved correctly");
		assert(n.get() !== undefined, "T40: null is not confused with undefined");

		const z = wf.state<number>("zeroVal");
		await z.set(0);
		assert(z.get() === 0, "T40: zero stored and retrieved correctly");

		const e = wf.state<string>("emptyVal");
		await e.set("");
		assert(e.get() === "", "T40: empty string stored and retrieved correctly");
	}

	console.log("\nTest 41: diff() — first call, everything is added");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		const items = [{ id: "alpha" }, { id: "beta" }];
		const result = await wf.diff("items", items, (i) => i.id);
		assert(result.added.length === 2, "T41: all items added on first call");
		assert(result.removed.length === 0, "T41: nothing removed on first call");
		assert(result.kept.length === 0, "T41: nothing kept on first call");
	}

	console.log("\nTest 42: diff() — second call detects changes");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		// First call
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			await wf.diff("items", [{ id: "a" }, { id: "b" }, { id: "c" }], (i) => i.id);
		}

		// Second call with changes
		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const result = await wf.diff("items", [{ id: "b" }, { id: "d" }], (i) => i.id);
			assert(result.added.length === 1, "T42: one added");
			assert(result.added[0].id === "d", "T42: 'd' is added");
			assert(result.removed.length === 2, "T42: two removed");
			assert(result.removed.includes("a"), "T42: 'a' removed");
			assert(result.removed.includes("c"), "T42: 'c' removed");
			assert(result.kept.length === 1, "T42: one kept");
			assert(result.kept[0].id === "b", "T42: 'b' is kept");
		}
	}

	console.log("\nTest 43: diff() — survives across executions");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			await wf.diff("brokers", [{ id: "x" }, { id: "y" }], (b) => b.id);
		}

		copyState(stateStore, 1, 2);

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(2, 1, "wf", storage);
			const result = await wf.diff("brokers", [{ id: "y" }, { id: "z" }], (b) => b.id);
			assert(result.added.length === 1, "T43: one added across executions");
			assert(result.added[0].id === "z", "T43: 'z' added");
			assert(result.removed.length === 1, "T43: one removed across executions");
			assert(result.removed[0] === "x", "T43: 'x' removed");
		}
	}

	console.log("\nTest 44: kv() — basic operations");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		const children = wf.kv<number>("children");

		assert(children.get("a") === undefined, "T44: get non-existent returns undefined");
		assert(children.has("a") === false, "T44: has non-existent returns false");
		assert(children.keys().length === 0, "T44: keys empty initially");

		await children.set("a", 42);
		assert(children.get("a") === 42, "T44: get returns set value");
		assert(children.has("a") === true, "T44: has returns true after set");
		assert(children.keys().length === 1, "T44: keys has one entry");

		await children.set("b", 99);
		assert(children.entries().length === 2, "T44: entries has two entries");

		await children.delete("a");
		assert(children.get("a") === undefined, "T44: get returns undefined after delete");
		assert(children.has("a") === false, "T44: has returns false after delete");
		assert(children.keys().length === 1, "T44: keys has one entry after delete");
	}

	console.log("\nTest 45: kv() — survives across executions");
	{
		const stateStore = new Map<number, Record<string, unknown>>();

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(1, 1, "wf", storage);
			const m = wf.kv<string>("map");
			await m.set("key1", "val1");
			await m.set("key2", "val2");
		}

		copyState(stateStore, 1, 2);

		{
			const storage = makeStorage(stateStore);
			const { wf } = buildWf(2, 1, "wf", storage);
			const m = wf.kv<string>("map");
			assert(m.get("key1") === "val1", "T45: key1 survives");
			assert(m.get("key2") === "val2", "T45: key2 survives");
		}
	}

	console.log("\nTest 46: state is in 'state' bucket, not at root");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		const counter = wf.state<number>("retry_count");
		await counter.set(3);

		const state = stateStore.get(1)!;
		// Should be in state.state.retry_count, not state.retry_count
		assert((state.state as any)?.retry_count === 3, "T46: state in 'state' bucket");
		assert((state as any).retry_count === undefined, "T46: NOT at root level");
	}

	console.log("\nTest 47: kv is in 'kv' bucket");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		const m = wf.kv<number>("children");
		await m.set("broker-1", 42);

		const state = stateStore.get(1)!;
		const kvBucket = state.kv as Record<string, unknown>;
		assert(kvBucket !== undefined, "T47: kv bucket exists");
		const childrenMap = kvBucket.children as Record<string, number>;
		assert(childrenMap["broker-1"] === 42, "T47: kv stored in kv bucket");
	}

	console.log("\nTest 48: diff is in 'diff' bucket");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		await wf.diff("brokers", [{ id: "a" }], (b) => b.id);

		const state = stateStore.get(1)!;
		const diffBucket = state.diff as Record<string, unknown>;
		assert(diffBucket !== undefined, "T48: diff bucket exists");
		assert(Array.isArray(diffBucket.brokers), "T48: diff stored as array of keys");
		assert((diffBucket.brokers as string[])[0] === "a", "T48: key 'a' stored");
	}

	console.log("\nTest 49: changed is in 'changed' bucket");
	{
		const stateStore = new Map<number, Record<string, unknown>>();
		const storage = makeStorage(stateStore);
		const { wf } = buildWf(1, 1, "wf", storage);

		await wf.changed("listing", { price: 100 });

		const state = stateStore.get(1)!;
		const changedBucket = state.changed as Record<string, unknown>;
		assert(changedBucket !== undefined, "T49: changed bucket exists");
		assert((changedBucket.listing as any).price === 100, "T49: native value in changed bucket");
	}
}
