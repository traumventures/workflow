# Run Retries

Steps have their own retry logic, but sometimes the **workflow function itself** throws an unexpected error outside of any step (e.g., a bug, an uncaught exception). Run-level retries handle this.

```ts
await engine.run("my-workflow:1", input, {
  instance: { ... },
  maxAttempts: 3,  // default: 1 (no run-level retry)
});
```

## How It Works

If the workflow function throws something that's NOT a `FatalError` and NOT a step retry (i.e., an uncaught `Error` outside any step), the executor returns `{ outcome: "failed" }`. The worker then checks:

- `run.attempts < run.maxAttempts` → re-schedule with exponential backoff (`1s × 2^(attempts-1)`).
- `run.attempts >= run.maxAttempts` → permanent failure. Run is marked `"failed"`.

## When to Use

- **Default `maxAttempts: 1`:** Most workflows should rely on **step-level retries** for transient failures. Run-level retry is a safety net.
- **`maxAttempts: 3`:** For workflows where unhandled errors are expected (e.g., a library throws sporadically).

> **Note:** Run-level retries do NOT reset step state. All completed steps are still replayed. This means run-level retry only helps for errors that occur outside of steps.

---

Next: [Lifecycle Hooks](15-lifecycle-hooks.md)
