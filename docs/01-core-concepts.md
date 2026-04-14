# Core Concepts

The engine is built around a single root primitive — **state** — and several higher-level concepts:

| Concept       | What it does                                                                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**  | The registered function/code identified by a versioned name (e.g. `lead-qualification:1`). Defines the logic; has no state of its own.                                                                                                          |
| **Instance**  | A durable identity defined by a workflow `name` + an `instance` object. Has a stable numeric `instanceId`. Groups zero or more runs — a new run is created each time the instance is triggered or reruned.                       |
| **Run** | One immutable attempt within an instance. Has an `runId`, a `status`, JSON `input`/`output`, and a single `state` JSONB column containing all persisted data. Once an run finishes (completed or failed), it is never mutated — a rerun creates a fresh run. |
| **State**     | A single JSONB column on the run row containing typed **buckets**. Every primitive — steps, memos, sleeps, events, changed, diff, kv, and user state — stores its data in its own bucket. All primitives are built on one internal function: `rawState(type, key)`. |
| **Storage**   | A pluggable persistence layer (interface `WorkflowStorage`). The production implementation uses PostgreSQL + Drizzle.                                                                                                                            |

## State Buckets

All workflow data lives in a single `state` JSONB column, organized into typed buckets:

| Bucket      | Primitive            | What it stores                                                           |
| ----------- | -------------------- | ------------------------------------------------------------------------ |
| `step`      | `wf.step()`         | Durable step entries: status, result (native JSONB), error, attempts, seq, timing |
| `memo`      | `wf.memo()`         | Raw memoized values (the return value directly)                          |
| `sleep`     | `wf.waitForDuration()`        | Sleep entries: `{ wakeAt }` — presence means "already slept"             |
| `event`     | `wf.waitForEvent()` | Event entries: `{ status, token, data? }` — waiting or delivered         |
| `changed`   | `wf.changed()`      | Previous values for change detection (native, not serialized)            |
| `diff`      | `wf.diff()`         | Previous key sets for array diff                                         |
| `kv`        | `wf.kv()`           | Persistent key-value maps                                                |
| `state`     | `wf.state()`        | User-defined persistent variables                                        |

```ts
// Example state blob structure
{
  "step":    { "fetch": { status: "completed", result: { id: 1 }, seq: 1, ... } },
  "memo":    { "shuffle": [3, 1, 2] },
  "sleep":   { "after-fetch": { wakeAt: "2026-03-26T10:00:00Z" } },
  "event":   { "approval": { status: "delivered", token: "42:approval", data: { approved: true } } },
  "changed": { "listing": { price: 100 } },
  "diff":    { "brokers": ["broker-1", "broker-2"] },
  "kv":      { "children": { "broker-1": 42 } },
  "state":   { "retry_count": 3 }
}
```

## The `rawState` Primitive

Every context method is built on one internal function:

```ts
rawState<T>(type: string, key: string): WorkflowState<T>
```

This reads/writes to `stateCache.data[type][key]` and persists via `storage.setState()`. The function is not exposed on `WorkflowContext` — it's an internal implementation detail that all public primitives delegate to.

## Why It Works

When the engine executes a workflow function, it replays all previously-completed steps (returning stored results instantly), then executes the next pending step. If the process crashes mid-step, the run is re-claimed after a stale timeout and replayed from scratch — but all completed steps are skipped, so the workflow resumes exactly where it left off.

```
Workflow function:
  step("A") → replayed (stored)
  step("B") → replayed (stored)
  step("C") → EXECUTES (first time)  ← we are here
  step("D") → not reached yet
```

This replay model means:

- **Completed steps are free.** Replaying 100 cached steps takes microseconds — no I/O, no network calls.
- **Crashes are transparent.** The workflow function doesn't need to know it was interrupted. It re-executes from the top and fast-forwards through cached steps.
- **Side effects are at-most-once** (per successful step). If a step sends an email and then the result is persisted, that email won't be sent again on replay.

---

Next: [Quick Start](02-quick-start.md)
