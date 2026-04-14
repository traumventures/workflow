# Sleeping

## `waitForDuration()` — Timed Delays

```ts
await wf.waitForDuration("5m");
await wf.waitForDuration("2h");
await wf.waitForDuration("7d");
```

### Duration Units

| Unit | Example    | Milliseconds  |
| ---- | ---------- | ------------- |
| `ms` | `"500ms"`  | 500           |
| `s`  | `"30s"`    | 30,000        |
| `m`  | `"5m"`     | 300,000       |
| `h`  | `"2h"`     | 7,200,000     |
| `d`  | `"7d"`     | 604,800,000   |
| `w`  | `"1w"`     | 604,800,000   |

### Sleeping with Date Objects

`waitForDuration()` also accepts a `Date` object — it computes the delta and sleeps until that point in time:

```ts
const targetDate = new Date("2026-03-15T18:00:00Z");
await wf.waitForDuration(targetDate);  // sleeps until that exact time
```

If the date is already in the past, the sleep returns immediately (no-op).

### How It Works

Sleep is its own primitive — it stores `{ wakeAt }` in the `sleep` bucket of the run state, not as a step entry.

1. First call: persists `{ wakeAt }` in the `sleep` bucket, then throws `SuspendSignal` internally.
2. The executor catches the signal, returns `{ outcome: "suspended", reason: "sleep", runAt }`.
3. The worker sets the run status to `"sleeping"` and `runAt` to the wake-up time.
4. When `runAt` passes, the worker re-claims the run, replays the workflow. The sleep entry is found in the bucket, so `waitForDuration()` returns immediately and run continues.

### Storage

```ts
// state.sleep["after-fetch"]
{ wakeAt: "2026-03-26T10:00:00Z" }
```

Presence of the key means "already slept" — no status field needed.

### Labels — Disambiguating Multiple Sleeps

If you have two `sleep("5m")` calls in the same run path, they'd collide without labels. Use labels to disambiguate:

```ts
await wf.waitForDuration("5m", "after-fetch");    // key: "after-fetch" in sleep bucket
// ... do work ...
await wf.waitForDuration("5m", "after-send");     // key: "after-send" in sleep bucket
```

Without labels, the engine uses an auto-incrementing counter (`"0"`, `"1"`, etc.), which works for unlabeled sleeps as long as they're always encountered in the same order across replays.

> **Best practice:** Use labels when you have multiple sleeps with the same duration, or when sleeps are inside conditional branches (to ensure consistent ordering).

## `waitForDate()` — Concrete Timestamps

When you need to suspend a workflow until a specific point in time rather than for a duration:

```ts
await wf.waitForDate(new Date("2026-03-15T18:00:00Z"));
await wf.waitForDate("2026-03-15T18:00:00.000Z");  // ISO 8601 strings also work
```

### How It Works

`waitForDate` computes the delta between now and the target time, then delegates to `waitForDuration()` internally. If the target time is already in the past, it returns immediately — no sleep entry is created.

### Labels

Like `waitForDuration()`, you can pass an optional label as the second argument:

```ts
await wf.waitForDate(firstSlot, "first-window");
await wf.waitForDate(secondSlot, "second-window");
```

If no label is provided, `waitForDate` auto-generates one using the target timestamp (`__until:{timestampMs}`).

---

Next: [Polling](07-polling.md)
