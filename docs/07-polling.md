# Polling (Check-Sleep Loops)

When you need to repeatedly check a condition and sleep between attempts — rate-limit enforcement, availability checks, external system readiness — use `wf.poll()`:

```ts
await wf.poll("send_slot", {
  check: async () => {
    const result = await canSendNow(platform, broker.email, config);
    if (result.ready) return { ready: true };
    return { ready: false, retryAfterMs: result.waitMs };
  },
  minIntervalMs: 30_000,  // at least 30s between checks (default)
});
```

## How It Works

`poll()` is syntactic sugar over a `while(true)` loop with `memo()` and `waitForDuration()` calls:

1. Each iteration memoizes the check result: `poll:{label}:{attempt}` in the `memo` bucket.
2. If `check()` returns `{ ready: true }`, the poll resolves and the workflow continues.
3. If `check()` returns `{ ready: false, retryAfterMs }`, the engine sleeps for `max(retryAfterMs, minIntervalMs)` milliseconds with key `poll:{label}:{attempt}` in the `sleep` bucket.
4. On wake-up, the next iteration checks again.

Poll checks are stored in the `memo` bucket (not `step`) because they're side-effect-free condition checks. Sleeps are stored in the `sleep` bucket.

## Auto-Logging

The engine automatically logs poll start and completion:
- `Poll "send_slot" started` — when poll begins
- `Poll "send_slot" ready after 3 check(s)` — when the condition is met

## PollOptions

```ts
interface PollOptions {
  /** Returns { ready: true } to proceed, or { ready: false, retryAfterMs } to sleep. */
  check: () => Promise<{ ready: true } | { ready: false; retryAfterMs: number }>;
  /** Minimum sleep duration between checks in ms. Default: 30000 (30s). */
  minIntervalMs?: number;
}
```

## When to Use

| Scenario                       | Use                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------- |
| Waiting for a send window      | `poll("send_slot", { check: canSendNow })`                                   |
| Rate-limit enforcement         | `poll("rate_limit", { check: () => checkGap(lastSentAt), minIntervalMs: 60_000 })` |
| External system readiness      | `poll("api_ready", { check: healthCheck })`                                   |

## Why Not `waitForDate`?

`waitForDate` is for a known concrete timestamp. `poll` is for when you don't know _exactly_ when the condition will be met — the check function re-evaluates on each wake-up with the latest state (e.g., the last sent message may have changed while sleeping).

---

Next: [Memoization](08-memoization.md)
