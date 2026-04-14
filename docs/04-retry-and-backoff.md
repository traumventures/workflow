# Retry & Backoff

When a step throws a **non-fatal** error and has `maxAttempts > 1`, the engine:

1. Persists the step as `"failed"` with the incremented attempt count.
2. Rethrows the error.
3. The executor catches it (it's not `FatalError`), reads the backoff delay from the context, and returns `{ outcome: "retryable", backoffMs }`.
4. The worker suspends the run with `runAt = now + backoff` and sets status to `"sleeping"`.
5. On the next poll after `runAt`, the run is re-claimed and the workflow function re-executes from the top — but all completed steps replay instantly, and the failed step is retried.

## Backoff Strategies

| Strategy         | Delay formula (attempt = 1, 2, 3, …) |
| ---------------- | ------------------------------------- |
| `"none"`         | 1s, 1s, 1s, …                        |
| `"linear"`       | 1s, 2s, 3s, 4s, …                    |
| `"exponential"`  | 1s, 2s, 4s, 8s, 16s, …              |

The base delay is always **1 second**.

## Example: HTTP Call With Retries

```ts
const [data] = await wf.step("call-api", async () => {
  const res = await fetch("https://api.example.com/data");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}, {
  maxAttempts: 5,
  backoff: "exponential",  // 1s → 2s → 4s → 8s → 16s
  timeout: "10s",
});
```

## Example: Fail-Open (Optional Step)

```ts
const [enrichment, err] = await wf.step("enrich", async () => {
  return await fetchEnrichmentData(leadId);
}, {
  maxAttempts: 2,
  onAllAttemptsFailed: "complete",  // returns StepResult<T | null>, workflow continues
});

if (err) {
  // All attempts failed — enrichment is null, err has the error message
  wf.log("warn", "Enrichment failed, continuing without it", { error: err });
} else {
  // use enrichment data
}
```

---

Next: [Rerun & Change Detection](05-rerun-and-changed.md)
