# Structured Logging

`wf.log()` appends structured log entries to the workflow run's persistent log. Logs are stored in the `workflow_logs` table and are visible via the REST API, CLI, and panel.

```ts
wf.log("info", "Listing fetched", { listingId, price: listing.price });
wf.log("warn", "Send failed, will retry", { error: result.error });
wf.log("error", "Fatal: broker not found", { brokerId });
```

## Log Levels

| Level     | Use case                                                                 |
| --------- | ------------------------------------------------------------------------ |
| `"info"`  | Normal progress: steps completed, data fetched, conditions met           |
| `"warn"`  | Recoverable issues: retries triggered, optional steps failed, edge cases |
| `"error"` | Unrecoverable issues: fatal errors, validation failures, missing data    |

## How It Works

- **Fire-and-forget:** `wf.log()` never blocks workflow run. The log is persisted asynchronously — if the write fails, it's silently swallowed.
- **Step context:** Each log entry automatically captures which step was executing at the time (`stepKey` field). This makes it easy to correlate logs with specific steps.
- **Not a replacement for Pino:** `wf.log()` is a structured audit trail that follows the run. Use your application logger (Pino) for operational logging; use `wf.log()` for workflow-scoped events that should be visible in the panel/CLI.

## Viewing Logs

```bash
# CLI — logs are included in the run detail view
mm workflows get 42

# REST API — logs are in the response body
GET /api/workflows/42  →  { ...run, steps, children, logs }
```

## Storage Requirements

`wf.log()` requires the `appendLog` and `getLogs` methods on `WorkflowStorage`. These are **optional** — if your storage implementation doesn't provide them, `wf.log()` is a silent no-op and `engine.getLogs()` returns an empty array.

```ts
interface WorkflowStorage {
  // ... other methods ...
  appendLog?(runId: number, entry: WorkflowLogEntry): Promise<void>;
  getLogs?(runId: number): Promise<WorkflowLogEntry[]>;
}
```

## Schema

```sql
CREATE TABLE workflow_logs (
  id           SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
  level        TEXT NOT NULL,
  message      TEXT NOT NULL,
  meta         TEXT,          -- JSON
  step_key     TEXT,          -- which step was executing (nullable)
  created_at   TEXT NOT NULL
);
```

## Auto-Logging

The engine automatically emits structured log entries for all context functions. Workflows do not need to manually log step mechanics — only business-level information.

### What's Auto-Logged

| Function | Log messages |
|----------|-------------|
| `step()` | `Step "X" replayed from cache` / `Step "X" rerunning (cached result discarded)` / `Step "X" completed` (with durationMs) / `Step "X" failed (attempt N/M)` / `Step "X" permanently failed` |
| `waitForDuration()` | `Sleeping for 5m` (with wakeAt) / `Sleep "label" already elapsed` |
| `waitForDate()` | `Sleeping until 2026-03-15T18:00:00Z` / `Sleep until "label" already in the past — skipping` |
| `poll()` | `Poll "send_slot" started` / `Poll "send_slot" ready after N check(s)` |
| `changed()` | `Changed "listing": new value` / `Changed "listing": value differs` / `Changed "listing": unchanged` |
| `diff()` | `Diff "brokers"` (with added/removed/kept counts) |
| `waitForEvent()` | `Waiting for event "approval"` / `Event "approval" already delivered` |

### What Workflows Should Log

With auto-logging handling mechanics, workflow `wf.log()` calls should focus on:
- **Business verdicts:** `"Listing disqualified: price too high"`
- **Domain context:** `"Outreach completed — message sent"` with assignment IDs
- **Decision points:** `"Fail-open: LLM filter timed out, treating as passed"`

```ts
// ❌ Redundant — engine already logs this
wf.log("info", "Step fetch completed");

// ✅ Business context that only the workflow knows
wf.log("info", "Listing disqualified", { reason: staticResult.reason });
```

---

Next: [Parent–Child Workflows](11-parent-child.md)
