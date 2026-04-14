# State Machines

## Run Lifecycle

```
                    ┌──────────────────────────────────────────────┐
                    │                                              │
                    ▼                                              │
              ┌─────────┐     worker claims     ┌─────────┐       │
  start() ──▶ │ pending │ ──────────────────▶   │ running │       │
              └─────────┘                       └─────────┘       │
                    ▲                           /    |    \        │
                    │                          /     |     \       │
         sendEvent()|              ┌──────────┘      |      └─────────────┐
            or wake │              │                  │                    │
                    │              ▼                  ▼                    ▼
              ┌──────────┐   ┌──────────┐     ┌───────────┐     ┌──────────┐
              │ waiting  │   │ sleeping │     │ completed │     │  failed  │
              │ (event)  │   │ (sleep/  │     └───────────┘     └──────────┘
              └──────────┘   │  retry)  │
                             └──────────┘

              Any non-terminal ──cancel()──▶ ┌───────────┐
                                             │ cancelled │
                                             └───────────┘
```

| Status      | Meaning                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `pending`   | Ready to be claimed by a worker. Either freshly created or woken from sleep/event.                |
| `running`   | Currently being executed by a worker. `claimedAt` tracks when the run was picked up.        |
| `sleeping`  | Suspended with a future `runAt`. Will become claimable when `runAt` passes.                       |
| `waiting`   | Suspended on an event. `runAt` is set to far future. Only woken by `engine.sendEvent()`.          |
| `completed` | Terminal. Workflow returned successfully. Output stored.                                           |
| `failed`    | Terminal. Unrecoverable error. Error message stored.                                              |
| `cancelled` | Terminal. Manually cancelled via `engine.cancel()`.                                               |

### Stale Run Recovery

If a worker crashes while an run is in `"running"`, the `claimedAt` timestamp goes stale. After `staleRunTimeoutMs` (default 5 minutes), another worker will re-claim it:

```sql
-- The claim query selects:
(status = 'pending' AND run_at <= now())
OR
(status = 'running' AND claimed_at < now() - stale_timeout)
```

## Step Lifecycle

```
                  ┌────────────────────────────────────────┐
                  │                                        │
                  ▼                                        │
  step() call → execute thunk                              │
                  │                                        │
           ┌──────┴──────┐                                 │
           │             │                                 │
        success       failure                              │
           │             │                                 │
           ▼             ├── FatalError? ──▶ "fatal"       │
      "completed"        │                                 │
      (durationMs)       ├── attempts >= max?              │
                         │      ├── onFail="fail" ──▶ "fatal"
                         │      └── onFail="complete" ──▶ "completed" (undefined)
                         │                                 │
                         └── attempts < max ──▶ "failed" ──┘
                              (run rescheduled for retry)
```

| Status      | Meaning                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| `completed` | Step succeeded. Result and `durationMs` stored. On replay, returns stored result without calling thunk.      |
| `failed`    | Step failed but has retries remaining. On next run attempt, the step will be re-attempted.             |
| `fatal`     | Step permanently failed. On replay, throws `FatalError`. Run cannot proceed past this step.            |

### Sequence Numbers

Every step is assigned a monotonically increasing `seq` number (1, 2, 3, …) within its run. The `seq` is assigned when a step is first persisted and never changes — retries of a failed step reuse the original `seq`.

Sequence numbers ensure stable ordering across retries and reruns. When `rerun: true`, a step's `seq` is preserved so it keeps its position in the sequence.

### Rerun Behavior

When `rerun: true`:

- A `completed` step's cached state is ignored — the thunk re-executes.
- A `failed` or `fatal` step is also re-executed with a fresh attempt count.
- The step's `seq` is preserved so ordering remains stable.
- The step appears in `completedSteps` (fires `onStepCompleted` hooks).

---

Next: [API Reference](20-api-reference.md)
