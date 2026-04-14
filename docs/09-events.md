# Events (External Signals)

Events let a workflow **pause indefinitely** until an external system delivers data. This is the mechanism for human-in-the-loop, webhook callbacks, or delivery confirmations.

## Webhook-Style API

### In the Workflow

```ts
const approval = await wf.waitForEvent<{ approved: boolean }>("approval");
// Workflow suspends here — zero CPU, zero DB writes while waiting
// Run resumes when engine.sendEvent(runId, "approval", data) is called
if (!approval.approved) {
  throw new FatalError("Denied");
}
```

### Delivering Events

**From code (engine API):**

```ts
await engine.sendEvent(runId, "approval", { approved: true });
```

**From HTTP (REST endpoint):**

```
POST /api/workflows/42/events/approval
Content-Type: application/json

{ "approved": true }
```

Response: `{ "ok": true, "runId": 42, "event": "approval" }`

## How It Works

Events are stored in the `event` bucket of the run state — a separate primitive from steps.

1. `waitForEvent("approval")` generates a token `{runId}:approval` and persists `{ status: "waiting", token: "42:approval" }` in the `event` bucket, then throws `SuspendSignal`.
2. The run transitions to `"waiting"` status with `runAt` set to far future (2124-01-01).
3. When `engine.sendEvent(runId, "approval", data)` is called:
   - The storage layer finds the event entry with the matching token.
   - Updates it to `{ status: "delivered", token: "42:approval", data: { approved: true } }`.
   - Sets the run back to `"pending"` with `runAt = now()`.
4. On the next poll, the worker re-claims the run, replays the workflow. The event entry is found with `status: "delivered"`, so `waitForEvent()` returns the data and run continues.

### Storage

```ts
// state.event["42:approval"] — waiting
{ status: "waiting", token: "42:approval" }

// state.event["42:approval"] — after delivery
{ status: "delivered", token: "42:approval", data: { approved: true } }
```

## Token Generation

The token is **auto-generated** from `{runId}:{eventName}`:

- Inside workflow: `wf.waitForEvent("delivery")` → token is `42:delivery` (for run #42)
- Outside: `engine.sendEvent(42, "delivery", data)` → constructs the same token

No opaque token management needed. Callers only need the run ID and event name.

## Multiple Events

A workflow can wait for multiple events sequentially:

```ts
// Wait for first event
const step1 = await wf.waitForEvent<StepData>("step-1-complete");

// Process, then wait for second event
await wf.step("process-step-1", () => processData(step1));
const step2 = await wf.waitForEvent<StepData>("step-2-complete");
```

Each event has an independent token and entry in the `event` bucket.

## Real-World Example: Delivery Confirmation

```ts
// In the workflow — after sending a message:
await wf.step("send", () => sendMessage(listing, broker));

const delivered = await wf.waitForEvent<{ passed: boolean; reason?: string }>(
  "delivery-confirmed",
);

if (!delivered.passed) {
  return { verdict: `failed:${delivered.reason}` };
}
return { verdict: "sent" };
```

```ts
// In a status sync service — polling scraper APIs:
if (result.status === "sent") {
  await engine.sendEvent(outreachRunId, "delivery-confirmed", {
    passed: true,
  });
}
```

The workflow uses **zero CPU and zero DB writes** while waiting. It only wakes up when the event arrives.

---

Next: [Structured Logging](10-logging.md)
