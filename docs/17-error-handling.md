# Error Handling — The Full Picture

There are three error classes exported from the package:

## `FatalError`

```ts
import { FatalError } from "@traumwohnung/workflow";

throw new FatalError("Cannot proceed — data is invalid");
```

- **Inside a step:** Immediately marks the step as `"fatal"`. No retries regardless of `maxAttempts`. The run is permanently failed.
- **Outside a step:** The run is permanently failed (no run-level retry either).

Use for: validation failures, missing required data, unrecoverable conditions.

## `RetryableError`

```ts
import { RetryableError } from "@traumwohnung/workflow";

throw new RetryableError("Rate limited", { retryAfter: "30s" });
```

Treated the same as any regular `Error` inside a step — triggers retry if attempts remain.

## `StepTimeoutError`

Thrown internally by the engine when a step exceeds its `timeout`. Treated as a retryable failure — the step will be retried if it has attempts remaining.

## Error Flow Decision Tree

```
Step throws error
  ├── SuspendSignal? → re-throw (sleep/event handling)
  ├── FatalError? → step = "fatal", run = "failed" (permanent)
  ├── attempts < maxAttempts? → step = "failed", run rescheduled (retryable)
  └── attempts >= maxAttempts?
       ├── onAllAttemptsFailed = "complete"? → return [null, error, true], continue
       └── onAllAttemptsFailed = "fail"? → promote to FatalError, run = "failed"
```

---

Next: [Storage Implementation](18-storage.md)
