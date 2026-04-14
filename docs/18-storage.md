# Storage Implementation

The `WorkflowStorage` interface is the contract between the engine and your persistence layer. The production implementation uses PostgreSQL + Drizzle ORM.

## Schema (PostgreSQL)

```sql
-- Instances (stable identity per workflow + unique key)
CREATE TABLE workflow_instances (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  instance    JSONB NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

-- Runs (immutable attempt — always a new row)
CREATE TABLE workflow_runs (
  id                   SERIAL PRIMARY KEY,
  instance_id          INTEGER NOT NULL REFERENCES workflow_instances(id),
  status               TEXT NOT NULL, -- pending|running|sleeping|waiting|completed|failed|cancelled
  input                TEXT NOT NULL, -- JSON
  output               TEXT,          -- JSON
  error                TEXT,
  queue                TEXT NOT NULL DEFAULT 'default',
  parent_run_id  INTEGER,
  attempts             INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 1,
  backoff              TEXT NOT NULL DEFAULT 'exponential',
  state                JSONB NOT NULL DEFAULT '{}',  -- single source of truth: typed buckets
  claimed_at           TEXT,
  run_at               TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- Logs
CREATE TABLE workflow_logs (
  id           SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
  level        TEXT NOT NULL,    -- info|warn|error
  message      TEXT NOT NULL,
  meta         TEXT,             -- JSON
  step_key     TEXT,             -- which step was executing
  created_at   TEXT NOT NULL
);
```

All workflow data lives in the single `state` JSONB column, organized into typed buckets:

```jsonc
{
  "step":    { /* StepEntry objects keyed by step name */ },
  "memo":    { /* raw memoized values keyed by memo name */ },
  "sleep":   { /* { wakeAt } entries keyed by sleep label */ },
  "event":   { /* EventEntry objects keyed by token */ },
  "changed": { /* native values keyed by label */ },
  "diff":    { /* string[] of previous keys, keyed by diff name */ },
  "kv":      { /* Record<string, T> maps keyed by kv name */ },
  "state":   { /* user-defined values keyed by state name */ }
}
```

## Key Storage Operations

| Method                      | What it does                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upsertInstance()`          | Insert-or-return an instance. Returns the existing instance if one already exists with the same name + identity object.                                    |
| `createRun()`          | Atomically upsert instance + insert run, enforcing at-most-one active run per instance.                                                       |
| `claimPendingRuns()`  | Atomically claims pending runs (or stale running runs). Sets status=running, claimedAt=now, attempts++.                                       |
| `suspendRun()`        | Sets status to `"sleeping"` (for sleep/retryable) or `"waiting"` (for event). Updates `runAt`.                                                           |
| `deliverHookSignal()`       | Updates the event entry in `state.event` from `"waiting"` to `"delivered"` with the data, sets run back to `"pending"`.                             |
| `cancelChildren()`          | Recursive CTE to cancel all descendant runs.                                                                                                        |
| `rerunInstance()`       | Finds the latest run, copies its `state` column into a new run (filtering the `step` bucket to only completed steps), returns the new ID.     |
| `getState()`                | Get the `state` JSONB for an run. Returns parsed object (empty `{}` if no state). This is the single source of truth for all primitives.            |
| `setState()`                | Replace the entire `state` JSONB for an run. Called by `rawState().set()` internally.                                                               |
| `findRunWaitingForHook()` | Scans `state.event` bucket of waiting runs to find one with a matching token.                                                                   |
| `getInstance()`             | Fetch a `WorkflowInstance` by ID.                                                                                                                         |
| `getRun()`            | Fetch a `WorkflowRun` by ID.                                                                                                                        |
| `getLatestRun()`      | Fetch the most-recently-created run for a given instance ID.                                                                                        |
| `getRuns()`           | Fetch all runs for a given instance ID, ordered by `createdAt DESC`.                                                                                |
| `appendLog()`               | _(Optional)_ Appends a structured log entry for an run.                                                                                             |
| `getLogs()`                 | _(Optional)_ Returns all log entries for an run, ordered by `createdAt`.                                                                            |

## Utility Functions

The workflow package exports helpers for extracting data from the state blob:

```ts
import { extractSteps, extractMemos, extractSleeps, extractEvents } from "@traumwohnung/workflow";

const steps = extractSteps(run.state);   // StepEntry[] sorted by seq
const memos = extractMemos(run.state);   // { key, value }[]
const sleeps = extractSleeps(run.state); // SleepEntry[]
const events = extractEvents(run.state); // EventEntry[]
```

## Domain Tables

When your application stores a reference to the workflow in its own tables, use the stable `workflowInstanceId` — not the run ID — so the reference survives reruns:

```sql
ALTER TABLE leads ADD COLUMN workflow_instance_id INTEGER;
ALTER TABLE broker_assignments ADD COLUMN workflow_instance_id INTEGER;
```

## Implementing Custom Storage

For testing, you can use an in-memory implementation (see the test harness in the package). For production, implement all methods of the `WorkflowStorage` interface against your database. The `appendLog` and `getLogs` methods are optional — if not provided, `wf.log()` is a silent no-op.

The key insight: all primitives read/write through `getState()` / `setState()`. Your storage layer only needs to persist one JSONB column per run.

---

Next: [State Machines](19-state-machines.md)
