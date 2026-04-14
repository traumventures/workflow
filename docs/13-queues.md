# Queues & Concurrency

Queues control **which pool of workers** processes an run and how many runs can run concurrently.

```ts
const engine = createEngine({
  storage: pgStorage,
  queues: {
    leads: { concurrency: 5, pollIntervalMs: 2_000 },
    default: { concurrency: 10, pollIntervalMs: 1_000 },
  },
  defaultQueue: "default",
});
```

## Queue Configuration

| Option                | Default        | Description                                                                                                                               |
| --------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`         | 10             | Max runs processed simultaneously per queue.                                                                                        |
| `pollIntervalMs`      | 1000           | How often the worker polls for new runs (ms).                                                                                       |
| `staleRunTimeoutMs` | 300000 (5 min) | If an run stays in `"running"` longer than this without completing, the worker assumes the previous worker crashed and re-claims it. |

## Assigning a Queue

```ts
await engine.run("my-workflow:1", input, {
  queue: "leads",  // processed by the "leads" queue worker
});
```

If omitted, the `defaultQueue` is used (default: `"default"`).

## When to Use Multiple Queues

| Scenario                                     | Recommendation                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| CPU-intensive vs I/O-bound workflows         | Separate queues with different concurrency.                                 |
| Priority processing                          | Low-concurrency queue for high-priority work → gets processed immediately.  |
| Rate limiting                                | `concurrency: 1` to serialize access to a rate-limited API.                |
| Isolation                                    | Keep scraping workflows on a different queue from email-sending workflows.  |

## How Polling Works

Each queue has its own `WorkerLoop`:

1. Every `pollIntervalMs`, it checks: `available = concurrency - inflight`.
2. If `available > 0`, it claims up to `available` pending runs from the DB.
3. Claimed runs are dispatched concurrently (not awaited — fire-and-forget within the loop).
4. When an run completes/fails/suspends, `inflight` decrements.

---

Next: [Run Retries](14-run-retries.md)
