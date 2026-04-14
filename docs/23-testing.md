# Testing

## Running Tests

```bash
cd packages/workflow
bun run tests/run-all.ts
```

## In-Memory Storage

The test harness uses a minimal in-memory `WorkflowStorage` implementation backed by a `Map<number, Record<string, unknown>>` for state. This is useful for unit testing workflows without a database:

```ts
import { makeStorage, buildCtx } from "../tests/harness";

const stateStore = new Map<number, Record<string, unknown>>();
const storage = makeStorage(stateStore);
const { ctx } = buildCtx(1, 1, "test-wf", storage);

// Now call your workflow function
const result = await myWorkflow({ url: "https://example.com" }, wf);

// Inspect the state
const state = stateStore.get(1)!;
const steps = state.step as Record<string, StepEntry>;
assert(steps["fetch"]?.status === "completed");
```

The in-memory storage implements all `WorkflowStorage` methods including `deliverHookSignal` (updates `state.event` bucket) and `getState`/`setState` (reads/writes from the map).

## What's Tested

The test suite (197 assertions) covers:

- **Steps**: memoization (thunk only called once), replay, FatalError, retry with maxAttempts, onAllAttemptsFailed="complete", SuspendSignal propagation, native result storage
- **Memos**: own bucket storage, raw values, undefined handling, rerun
- **Sleeps**: suspend/replay, labels, counter-based keys, Date objects, sleepUntil, own bucket (not step)
- **Events**: waitForEvent suspend/resume, auto-generated tokens, multiple independent events, deliverHookSignal via storage, own bucket (not step)
- **Backoff**: computeBackoffMs (none/linear/exponential), step timeouts, retry then success, fail-open on replay
- **Rerun**: re-run, seq preservation, memo rerun, dependency chains, recovery from fatal
- **Changed**: first call, same/different values, key order independence, primitives, arrays, nested objects, cross-run, native value storage
- **State**: get/set, cross-run persistence, complex objects, null/zero/empty, bucket isolation
- **Diff**: added/removed/kept, first call, cross-run
- **KV**: get/set/delete/has/keys/entries, cross-run
- **Bucket isolation**: each primitive stores in its own bucket, not in step or at root

## Testing Workflows Directly

You can test a workflow function by using `buildCtx()` from the harness:

```ts
import { buildCtx, makeStorage } from "../tests/harness";

const stateStore = new Map<number, Record<string, unknown>>();
const storage = makeStorage(stateStore);
const { ctx } = buildCtx(1, 1, "test-wf", storage);
//               ^         ^  ^   ^
//               buildCtx(runId, instanceId, workflowName, storage)

// Call your workflow function
const result = await myWorkflow({ url: "https://example.com" }, wf);

// Assert on the result and state
assert(result.title === "Example");

const state = stateStore.get(1)!;
const steps = (state.step ?? {}) as Record<string, StepEntry>;
assert(steps["fetch"]?.status === "completed");
assert(steps["parse"]?.status === "completed");
```

## Seeding State for Tests

Use the `seedStep` and `completedStep` helpers to set up pre-existing state:

```ts
import { seedStep, completedStep, makeStorage, buildCtx } from "../tests/harness";

const stateStore = new Map<number, Record<string, unknown>>();

// Seed a completed step
seedStep(stateStore, 1, "fetch", completedStep({ id: 1, title: "Test" }, 1));

// Build context — the step will be replayed from cache
const storage = makeStorage(stateStore);
const { ctx } = buildCtx(1, 1, "test-wf", storage);
const [data, , fresh] = await wf.step("fetch", async () => { throw new Error("should not run"); });
assert(data.id === 1);
assert(fresh === false); // replayed from cache
```

## Simulating Rerun

Use `copyState` to simulate the state copy that happens during rerun:

```ts
import { copyState, makeStorage, buildCtx } from "../tests/harness";

const stateStore = new Map<number, Record<string, unknown>>();

// Run 1: set some state
{
  const storage = makeStorage(stateStore);
  const { ctx } = buildCtx(1, 1, "wf", storage);
  await wf.state<string>("color").set("blue");
}

// Simulate rerun: copy state from exec 1 → exec 2
copyState(stateStore, 1, 2);

// Run 2: state is inherited
{
  const storage = makeStorage(stateStore);
  const { ctx } = buildCtx(2, 1, "wf", storage);
  assert(wf.state<string>("color").get() === "blue");
}
```
