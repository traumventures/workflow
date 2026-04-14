# Steps — Durable Side Effects

```ts
const [result] = await wf.step("step-key", async () => {
  // Your async work here.
  // The return value is stored as native JSONB.
  return { data: 42 };
});
```

## Key Rules

1. **Step keys must be unique** within a workflow run. Two calls to `wf.step("fetch", ...)` in the same run path will collide — the second one will replay the first's result.

2. **Return values must be JSON-serializable.** Don't return class instances, functions, or circular structures. Plain objects, arrays, strings, numbers, booleans, and `null` are fine. Values are stored as native JSONB in the `step` bucket of the run state — no double-serialization.

3. **Thunks are only called once.** On replay (after crash, sleep wake-up, or event delivery), the engine returns the stored result without calling the thunk. This is the core durability guarantee.

4. **Side effects should be idempotent.** If a step sends an email and then crashes _before_ the result is persisted, the step will re-execute on the next attempt. Design your side effects accordingly.

5. **Run time is tracked.** Every step records its wall-clock duration in `durationMs`, available via lifecycle hooks and the API.

## Storage

Steps are stored in the `step` bucket of the run's `state` JSONB column:

```ts
// state.step["fetch"]
{
  status: "completed",
  result: { data: 42 },       // native value — not a JSON string
  error: null,
  attempts: 1,
  seq: 1,
  startedAt: "2026-03-19T10:00:00.000Z",
  completedAt: "2026-03-19T10:00:00.045Z",
  durationMs: 45,
  replayedAt: null
}
```

## Step Options

```ts
await wf.step("name", thunk, {
  maxAttempts: 3,                  // default: 1 (no retry)
  backoff: "exponential",          // "none" | "linear" | "exponential" (default)
  onAllAttemptsFailed: "fail",     // "fail" (default) | "complete"
  timeout: "30s",                  // number (ms) or duration string
  rerun: false,                    // force re-run (default: false)
});
```

| Option               | Description                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAttempts`        | Total attempts including the first. `1` = no retry.                                                                                                               |
| `backoff`            | Delay strategy between retries. See [Retry & Backoff](04-retry-and-backoff.md).                                                                                   |
| `onAllAttemptsFailed` | What happens when all attempts are exhausted. `"fail"` throws `FatalError` and kills the run. `"complete"` returns `StepResult<T \| null>` and the workflow continues. |
| `timeout`            | Max time the thunk may run. Accepts ms (`5000`) or a duration string (`"30s"`, `"2m"`, `"1h"`). If exceeded, a `StepTimeoutError` is thrown — retryable if attempts remain. |
| `rerun`              | Force re-run even if a cached result exists. See [Rerun & Change Detection](05-rerun-and-changed.md).                                                       |

## Step Result Tuple

`step()` returns a 3-tuple `StepResult<T> = [data, error, fresh]`:

```ts
type StepResult<T> = [T, string | null, boolean];
```

| Position | Name    | Type             | Description                                                              |
| -------- | ------- | ---------------- | ------------------------------------------------------------------------ |
| `[0]`    | `data`  | `T`              | The step result. `null` when fail-open and all attempts failed.          |
| `[1]`    | `error` | `string \| null` | Error message on fail-open failure. `null` on success.                   |
| `[2]`    | `fresh` | `boolean`        | `true` if the thunk executed this run. `false` if replayed from cache.   |

Array destructuring keeps the common case clean:

```ts
// Just grab the data (most common)
const [listing] = await wf.step("fetch", () => fetchListing(id));

// Check error (fail-open steps)
const [result, err] = await wf.step("enrich", () => enrichData(id), {
	onAllAttemptsFailed: "complete",
});
if (err) { /* handle gracefully */ }

// Check freshness (rare — usually use changed() instead)
const [data, , fresh] = await wf.step("fetch", () => fetchData(id));
```

## Type-Safe Fail-Open Steps

When you set `onAllAttemptsFailed: "complete"`, the return type is automatically `StepResult<T | null>` — no manual type assertions needed:

```ts
const [enrichment, err] = await wf.step("enrich", async () => {
	return await fetchEnrichmentData(leadId);
}, {
	maxAttempts: 2,
	onAllAttemptsFailed: "complete",
});

if (err) {
	// All attempts failed — enrichment is null, err has the error message
	wf.log("warn", "Enrichment failed, continuing without it", { error: err });
} else {
	// Use enrichment data
}
```

This is implemented via function overloads: the `step()` method has two signatures — one for the `"complete"` case that returns `Promise<StepResult<T | null>>`, and one for the default case that returns `Promise<StepResult<T>>`. The `[1]` error element replaces the old `undefined` sentinel.

---

Next: [Retry & Backoff](04-retry-and-backoff.md)
