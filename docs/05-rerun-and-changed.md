# Rerun & Change Detection

Two primitives for selectively re-executing steps without resetting the entire workflow.

## `rerun` Option

When `rerun: true` is passed to `step()` or `memo()`, the cached result is discarded and the thunk re-executes, returning a fresh value. The step's sequence number (`seq`) is preserved so ordering remains stable.

```ts
const [listing] = await wf.step("fetch", () => fetchListing(id), { rerun: true });
```

### How It Works

1. The engine checks for an existing entry in the relevant bucket (`step` for steps, `memo` for memos).
2. If `rerun: true` and an existing entry is found, the cached state is ignored.
3. The thunk executes fresh, and the new result overwrites the old one.
4. For steps, the `seq` is preserved so ordering remains stable.
5. The step appears in `completedSteps` (triggering `onStepCompleted` hooks).

### Dependency Chains

The real power of `rerun` is building React-hooks-style dependency chains. When an upstream step reruns, you pass the boolean downstream:

```ts
const needsRefetch = input.triggeredBy === "manual";

const [listing] = await wf.step("fetch", () => fetchListing(id), { rerun: needsRefetch });
const [filtered] = await wf.step("filter", () => filter(listing), { rerun: needsRefetch });
const [scored] = await wf.step("score", () => score(filtered), { rerun: needsRefetch });
```

### Rerun on Failed Steps

`rerun: true` also works on previously failed/fatal steps — it re-executes with a fresh attempt count:

```ts
const [result] = await wf.step("flaky", () => recoverableOperation(), { rerun: true });
```

### memo() with rerun

`memo()` also accepts `{ rerun }`:

```ts
const [shuffled] = await wf.memo("shuffle", () => shuffleArray(items), { rerun: needsReshuffle });
```

## `changed()` — Change Detection

`wf.changed(label, value)` compares the current value against the previously stored value. Returns `true` if different (or first call), `false` if identical.

```ts
const listingChanged = await wf.changed("listing", listing);
```

### How It Works

1. Compares `value` against the stored value using sorted-key JSON serialization for stable deep equality (so `{a:1, b:2}` and `{b:2, a:1}` are identical).
2. Reads the previous value from the `changed` bucket via `rawState("changed", label)`.
3. Always persists the current value (overwrites the old one).
4. Returns `true` if different or first call, `false` if identical.

### Storage

Values are stored as **native JSONB** in the `changed` bucket — not as serialized JSON strings:

```ts
// state.changed["listing"]
{ price: 100, zip: "10115" }   // native object, not '{"price":100}'
```

### Supported Types

Handles any JSON-serializable value:

- **Primitives:** strings, numbers, booleans, `null`
- **Arrays:** order matters — `[1, 2]` ≠ `[2, 1]`
- **Objects:** key order doesn't matter — `{a:1, b:2}` = `{b:2, a:1}`
- **Nested structures:** deep comparison

### Multiple Labels Are Independent

Each label tracks its own value independently:

```ts
const priceChanged = await wf.changed("price", listing.price);
const locationChanged = await wf.changed("location", listing.location);
```

## `state()` — Persistent Cross-Run Variables

`wf.state<T>(key)` returns a handle for a persistent variable that survives across runs within the same instance.

```ts
const counter = wf.state<number>("retry_count");
const current = counter.get(); // synchronous read (from in-memory cache)
await counter.set((current ?? 0) + 1); // persists immediately
```

### How It Works

- State lives in the `state` bucket of the JSONB `state` column on `workflow_runs`.
- On rerun, the entire state (all buckets) is copied from the latest run to the new one.
- `get()` is synchronous (reads from an in-memory cache loaded at context build time).
- `set()` persists immediately to storage.
- Multiple `state()` calls with different keys are independent.

### When to Use

- Tracking child workflow instance IDs (single child → `state`, multiple → `kv`)
- Accumulating counters across reruns
- Any persistent variable that isn't tied to a specific step

## `diff()` — Array Change Detection

`wf.diff<T>(key, currentItems, keyFn)` compares the current array against the previously stored array and returns `{ added, removed, kept }`.

```ts
const brokerDiff = await wf.diff("outreach_brokers", matchedBrokers, (b) => String(b.id));

for (const broker of brokerDiff.added) {
	// spawn new outreach
}
for (const removedId of brokerDiff.removed) {
	// cancel existing outreach
}
// brokerDiff.kept — leave existing outreach untouched
```

### Return Type

```ts
interface DiffResult<T> {
	added: T[];       // items present now but not before
	removed: string[]; // keys that were present before but are missing now
	kept: T[];         // items present both now and before
}
```

### How It Works

- `keyFn` extracts a unique string key from each item.
- The previous set of keys is stored in the `diff` bucket via `rawState("diff", key)`.
- On first call, all items are `added` (no previous set).
- State is copied on rerun, so the diff is cross-run.

## `kv()` — Persistent Key-Value Map

`wf.kv<T>(key)` returns a handle for a persistent map that tracks key-value pairs across runs.

```ts
const children = wf.kv<number>("outreach_children");

// After spawning a child workflow
await children.set(String(broker.id), result.instanceId);

// Later — check if we've already spawned for this broker
if (children.has(String(broker.id))) { ... }

// Iterate all tracked children
for (const [brokerId, instanceId] of children.entries()) { ... }
```

### API

| Method | Type | Description |
|--------|------|-------------|
| `get(key)` | `T \| undefined` | Read a value (synchronous) |
| `set(key, value)` | `Promise<void>` | Set a value (persists immediately) |
| `delete(key)` | `Promise<void>` | Remove a key (persists immediately) |
| `has(key)` | `boolean` | Check if key exists (synchronous) |
| `keys()` | `string[]` | All keys (synchronous) |
| `entries()` | `[string, T][]` | All entries (synchronous) |

### When to Use

- Tracking spawned child workflows: `brokerId → instanceId`
- Accumulating results from multiple steps
- Any map-shaped data that needs to persist across reruns

## Combined Pattern: `diff()` + `kv()` for Child Lifecycle

The killer combo — `diff()` detects broker set changes, `kv()` tracks spawned children:

```ts
const brokerDiff = await wf.diff("outreach_brokers", brokers, (b) => String(b.id));
const children = wf.kv<number>("outreach_children");

// Cancel outreach for removed brokers
for (const removedId of brokerDiff.removed) {
	const childInstanceId = children.get(removedId);
	if (childInstanceId) {
		const latest = await engine.getLatestRun(childInstanceId);
		if (latest) await engine.cancel(latest.id);
		await children.delete(removedId);
	}
}

// Spawn outreach for newly added brokers
for (const broker of brokerDiff.added) {
	const [result] = await wf.step(`spawn:${broker.id}`, () =>
		engine.run("outreach:1", { brokerId: broker.id }, {
			instance: { leadId, brokerId: broker.id },
			parentRunId: wf.runId,
		}),
	);
	await children.set(String(broker.id), result.instanceId);
}

// Kept brokers — no action needed
```

## Combined Pattern: `changed()` + `rerun`

The killer combo — `changed()` detects what changed, `rerun` drives selective re-run:

```ts
// Always re-fetch (get latest data)
const [listing] = await wf.step("fetch", () => fetchListing(id), { rerun: true });

// Only re-run downstream steps if the listing actually changed
const listingChanged = await wf.changed("listing", listing);
const [filtered] = await wf.step("filter", () => filter(listing), { rerun: listingChanged });
const [scored] = await wf.step("score", () => score(filtered), { rerun: listingChanged });
const [matched] = await wf.step("match", () => matchBrokers(scored), { rerun: listingChanged });
```

This is the workflow equivalent of React's `useMemo` with dependency arrays — re-compute only when inputs change.

### Real-World Example: Qualification Re-check

```ts
const qualificationWorkflow: WorkflowFn = async (input, wf) => {
  // Always fetch fresh listing data
  const [listing] = await wf.step("fetch", () => fetchListing(input.listingId), {
    rerun: true,
  });

  // Track what changed
  const listingChanged = await wf.changed("listing_data", {
    price: listing.price,
    rooms: listing.rooms,
    area: listing.area,
    zip: listing.zip,
  });

  // Only re-run expensive steps if the listing data actually changed
  const [staticResult] = await wf.step("static_filter", () => staticFilter(listing), {
    rerun: listingChanged,
  });
  if (!staticResult.passed) return { verdict: "disqualified" };

  const [llmResult] = await wf.step("llm_filter", () => llmFilter(listing), {
    rerun: listingChanged,
    maxAttempts: 2,
    timeout: "60s",
    onAllAttemptsFailed: "complete",
  });

  // Broker matching can also be gated on listing changes
  const [brokers] = await wf.step("broker_match", () => matchBrokers(listing), {
    rerun: listingChanged,
  });

  return { verdict: "qualified", brokerCount: brokers.length };
};
```

---

Next: [Sleeping](06-sleeping.md)
