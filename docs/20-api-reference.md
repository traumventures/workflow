# API Reference

## `createEngine(config: EngineConfig): WorkflowEngine`

Creates a new workflow engine instance.

```ts
interface EngineConfig {
  storage: WorkflowStorage;
  queues?: Record<string, QueueConfig>;    // default: { default: {...} }
  defaultQueue?: string;                    // default: "default"
  hooks?: LifecycleHooks;
}
```

## Engine Methods

### `engine.register_REMOVED(name: string, fn: WorkflowFn): void`

Register a workflow function by name. Must be called before `engine.run()`.

### `engine.run(name, input, opts): Promise<RunResult>`

Upsert a workflow instance and enqueue a new run. Returns `{ instanceId, runId }`.

```ts
interface RunOptions {
  instance: Record<string, unknown>;   // required — identity object for this instance
  queue?: string;
  runAt?: string;                      // ISO 8601, default: now
  parentRunId?: number;
  maxAttempts?: number;                // default: 1
  backoff?: "none" | "linear" | "exponential";
}

interface RunResult {
  instanceId: number;
  runId: number;
}
```

### `engine.run(): () => Promise<void>`

Start worker loops for all configured queues. Returns a `stop` function for graceful shutdown (waits up to 30s for in-flight runs to finish).

### `engine.sendEvent(runId: number, eventName: string, data: unknown): Promise<void>`

Deliver an event to a waiting workflow run. The run must be suspended on `wf.waitForEvent(eventName)`.

### `engine.cancel(runId: number): Promise<void>`

Cancel an run and all its non-terminal children recursively.

### `engine.rerun(instanceId: number): Promise<number>`

Create a new run for an existing instance. Copies the entire `state` column from the latest run (filtering the `step` bucket to only completed steps), so the workflow's `rerun`/`changed()` logic decides what to re-execute. Returns the new run ID.

### `engine.getInstance(instanceId: number): Promise<WorkflowInstance | null>`

Get a workflow instance by ID.

### `engine.getRun(runId: number): Promise<WorkflowRun | null>`

Get a single run by ID.

### `engine.getLatestRun(instanceId: number): Promise<WorkflowRun | null>`

Get the most recently created run for a given instance.

### `engine.getRuns(instanceId: number): Promise<WorkflowRun[]>`

Get all runs for a given instance, ordered by `createdAt DESC`.

### `engine.getChildren(runId: number): Promise<WorkflowRun[]>`

Get direct child runs.

### `engine.pendingCount(name: string): Promise<number>`

Count pending runs for a given workflow name.

### `engine.getLogs(runId: number): Promise<WorkflowLogEntry[]>`

Get persisted log entries for a workflow run.

## `WorkflowContext` (passed to workflow functions)

| Method / Property                        | Bucket     | Description                                                                                          |
| ---------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `wf.runId`                        | —          | Numeric ID of the current run.                                                                 |
| `wf.instanceId`                         | —          | Numeric ID of the stable workflow instance (survives reruns).                                    |
| `wf.workflowName`                       | —          | Name of the current workflow.                                                                        |
| `wf.step(key, thunk, opts?)`            | `step`     | Execute a durable step. Returns `StepResult<T>`. With `onAllAttemptsFailed: "complete"`, returns `StepResult<T \| null>`. |
| `wf.memo(key, fn, opts?)`               | `memo`     | Memoize a pure computation. Stores raw value. Accepts sync or async. Supports `{ rerun }`. Returns `StepResult<T>`. |
| `wf.waitForDuration(duration, label?)`            | `sleep`    | Suspend for a duration (`"30s"`, `"5m"`, `"2h"`, `"7d"`, `"1w"`, `"500ms"`) or until a `Date`.      |
| `wf.waitForDate(target, label?)`         | `sleep`    | Suspend until a specific `Date` or ISO 8601 string. Returns immediately if past.                     |
| `wf.waitForEvent<T>(eventName)`         | `event`    | Suspend until `engine.sendEvent(runId, eventName, data)` delivers data.                        |
| `wf.poll(label, opts)`                  | `memo`+`sleep` | Check-sleep loop using `memo()` + `waitForDuration()`. Repeats until `check()` returns `{ ready: true }`.  |
| `wf.changed(label, value)`              | `changed`  | Compare value against previous run. Returns `true` if changed or first call.                   |
| `wf.state<T>(key)`                      | `state`    | Persistent cross-run variable. Returns handle with `get()` (sync) and `set(value)` (async).    |
| `wf.diff<T>(key, items, keyFn)`         | `diff`     | Array diff against previous run. Returns `{ added, removed, kept }`.                           |
| `wf.kv<T>(key)`                         | `kv`       | Persistent key-value map. Returns handle with `get/set/delete/has/keys/entries`.                      |
| `wf.log(level, message, meta?)`         | —          | Append a structured log entry (fire-and-forget).                                                     |


All primitives are built on one internal function: `rawState<T>(type, key)` which reads/writes to `stateCache.data[type][key]`.

### StepResult\<T\>

Return type for `step()` and `memo()`.

```ts
type StepResult<T> = [T, string | null, boolean];
//                    data  error       fresh
```

| Position | Name | Type | Description |
|----------|------|------|-------------|
| `[0]` | `data` | `T` | Step result. `null` when fail-open and all attempts failed. |
| `[1]` | `error` | `string \| null` | Error message on fail-open failure. `null` on success. |
| `[2]` | `fresh` | `boolean` | `true` if thunk executed. `false` if replayed from cache. |

### StepOptions

```ts
interface StepOptions {
  maxAttempts?: number;                     // default: 1
  backoff?: "none" | "linear" | "exponential";  // default: "exponential"
  onAllAttemptsFailed?: "fail" | "complete";     // default: "fail"
  timeout?: number | string;                // ms or duration string
  rerun?: boolean;                          // default: false
}
```

### Entry Types

```ts
/** Stored in state.step bucket */
interface StepEntry {
  status: "completed" | "failed" | "fatal";
  result: unknown;            // native value
  error: string | null;
  attempts: number;
  seq: number;
  startedAt: string;
  completedAt: string;
  durationMs: number | null;
  replayedAt: string | null;
}

/** Stored in state.sleep bucket */
interface SleepEntry {
  wakeAt: string;  // ISO 8601
}

/** Stored in state.event bucket */
interface EventEntry {
  status: "waiting" | "delivered";
  token: string;
  data?: unknown;
}
```

## Utility Functions

```ts
import { extractSteps, extractMemos, extractSleeps, extractEvents } from "@traumwohnung/workflow";

extractSteps(state)   // → (StepEntry & { stepKey })[] sorted by seq
extractMemos(state)   // → { key, value }[]
extractSleeps(state)  // → (SleepEntry & { key })[]
extractEvents(state)  // → (EventEntry & { key })[]
```

## Duration Strings

Used in `waitForDuration()`, `timeout`, and `addDuration()`:

| Unit | Example    | Milliseconds  |
| ---- | ---------- | ------------- |
| `ms` | `"500ms"`  | 500           |
| `s`  | `"30s"`    | 30,000        |
| `m`  | `"5m"`     | 300,000       |
| `h`  | `"2h"`     | 7,200,000     |
| `d`  | `"7d"`     | 604,800,000   |
| `w`  | `"1w"`     | 604,800,000   |

---

Next: [Patterns & Recipes](21-patterns.md)
