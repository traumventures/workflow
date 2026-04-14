# Memoization (Deterministic Replay)

`wf.memo()` memoizes a pure computation for deterministic replay. Results are stored in the `memo` bucket — a separate, lightweight storage path from steps.

```ts
const [shuffledBrokers] = await wf.memo("shuffle", () => {
  const arr = [...brokers];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
});
```

## When to Use

Use `memo()` instead of `step()` when the computation:

- Is **pure** (no side effects, no I/O)
- Involves **non-determinism** that must be frozen on first run (e.g., `Math.random()`, `Date.now()`)
- Doesn't need retry/timeout/backoff semantics

Common use cases:

- Shuffling arrays for random ordering
- Computing jitter values for staggered sends
- Building spawn plans with random delays
- Any `Promise.resolve(value)` wrapper inside a `step()` — replace with `memo()`

## Storage

Memos are stored in the `memo` bucket of the run state. The value is the raw return value — no wrapper object, no status field:

```ts
// state.memo["shuffle"]
[3, 1, 2]

// state.memo["jitter"]
4200
```

This is much lighter than a step entry which carries status, attempts, seq, timing, etc.

## Return Value

`memo()` returns the same `StepResult<T>` tuple as `step()`: `[data, error, fresh]`.

```ts
const [data, error, fresh] = await wf.memo("compute", () => expensiveCalc());
// data   — the memoized result
// error  — always null (memo has no retry/fail-open semantics)
// fresh  — true if computed fresh this run, false if replayed from cache
```

In practice, you'll usually only need the first element.

## Why Not Just Use `step()`?

`memo()` is a distinct primitive with its own storage bucket. When you read a workflow, `memo("shuffle", ...)` immediately communicates: "This is here for replay determinism, not for durability or side effects." It also avoids the overhead of step entry fields (status, attempts, seq, durationMs) that are irrelevant for pure computations.

## Sync Support

Unlike `step()`, `memo()` accepts both sync and async functions:

```ts
// Async function
const [data] = await wf.memo("compute", async () => expensiveCalc());

// Sync function — no need to wrap in Promise.resolve()
const [jitter] = await wf.memo("jitter", () => Math.random() * 5000);
```

## Rerun Support

`memo()` accepts `{ rerun: true }` to force re-computation. See [Rerun & Change Detection](05-rerun-and-changed.md).

```ts
const [shuffled] = await wf.memo("shuffle", () => shuffleArray(items), { rerun: needsReshuffle });
```

---

Next: [Events](09-events.md)
