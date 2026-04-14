# Lifecycle Hooks

Hooks let you react to run/step state changes — for logging, metrics, notifications, or cascading actions.

```ts
const engine = createEngine({
  storage: pgStorage,
  hooks: {
    onRunStarted(run) {
      console.log(`🚀 Run ${run.id} (${run.name}) started`);
    },

    onRunCompleted(run) {
      console.log(`✅ Run ${run.id} (${run.name}) completed`);
      metrics.increment("workflow.completed");
    },

    onRunFailed(run, error) {
      console.error(`❌ Run ${run.id} failed:`, error);
      alerting.send(`Workflow ${run.name} failed: ${error}`);
    },

    onStepCompleted(run, stepKey, durationMs) {
      console.log(`  ✓ Step ${stepKey} completed in ${durationMs}ms`);
      metrics.histogram("workflow.step.duration", durationMs, { step: stepKey });
    },

    onStepFailed(run, stepKey, error, attempt) {
      console.warn(`⚠️ Step ${stepKey} failed (attempt ${attempt}):`, error);
    },

    onRunCancelled(run) {
      console.log(`🚫 Run ${run.id} cancelled`);
    },
  },
});
```

## Available Hooks

| Hook                   | When it fires                                       | Arguments                                   |
| ---------------------- | --------------------------------------------------- | ------------------------------------------- |
| `onRunStarted`   | Worker first picks up an run                  | `run: WorkflowRun`              |
| `onRunCompleted` | Run transitions to `"completed"`              | `run: WorkflowRun`              |
| `onRunFailed`    | Run permanently fails (all attempts exhausted)| `run: WorkflowRun`, `error`     |
| `onStepCompleted`      | A step completes successfully (not on replay)       | `run`, `stepKey`, `durationMs`        |
| `onStepFailed`         | A step fails (before retry or exhaustion)           | `run`, `stepKey`, `error`, `attempt`  |
| `onRunCancelled` | Run is cancelled                              | `run: WorkflowRun`              |

## Guarantees

- Hook errors are **caught and logged** — they never crash the worker or affect the run's status.
- Hooks are called **after** the status transition is persisted to the DB.
- `onRunCompleted` is called after the run is marked `"completed"` in storage.
- `onRunFailed` is only called when the run **permanently** fails (all run-level attempts exhausted).
- `onStepCompleted` is only called for **newly executed** steps — not for replayed steps that return cached results. This also applies to steps re-executed via `rerun: true`.

## Step Duration Tracking

The `onStepCompleted` hook receives the wall-clock run time in milliseconds via the `durationMs` argument. This is measured using `performance.now()` around the thunk run and is also persisted in the step's `durationMs` column in the database.

Use cases:

- **Metrics:** Emit histogram metrics per step name for monitoring dashboards.
- **Alerting:** Fire alerts when specific steps exceed duration thresholds.
- **Profiling:** Identify slow steps in workflow pipelines.

---

Next: [Cancel & Rerun](16-cancel-and-rerun.md)
