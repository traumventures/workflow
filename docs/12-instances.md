# Instances & Identity

An **instance** is the stable identity of a workflow — a named thing that persists across multiple runs. Every time `engine.run()` is called, the engine upserts an instance and creates a new run under it.

## The Three-Level Model

```
Workflow (name + version)
  └── Instance (workflow name + instance object = unique identity)
        └── Run (one run of the workflow, has steps)
              └── Steps
```

- A **workflow** is a registered function identified by name (e.g. `"lead-qualification:1"`).
- An **instance** represents a specific subject: e.g., listing `ka:12345`, or the outreach for lead 42 / broker 7.
- An **run** is one concrete run of the workflow function. Runs have status, steps, output, and error.

## Starting a Workflow

```ts
const { instanceId, runId } = await engine.run(
  "lead-qualification:1",
  { platform: "ka", listingId: "12345" },
  {
    instance: { platform: "ka", listingId: "12345" },
    queue: "leads",
  },
);
```

`engine.run()` always:
1. Derives an `instanceKey` from the workflow name + instance object (deterministic, sorted JSON).
2. Upserts the instance row (creates if new, finds existing if already there).
3. Creates a **new run** under that instance.
4. Returns `{ instanceId, runId }`.

## The `instanceKey`

The instance key is derived deterministically so callers don't need to manage it manually:

```ts
// Both of these produce the same instanceKey:
instance: { platform: "ka", listingId: "12345" }
instance: { listingId: "12345", platform: "ka" }  // key order doesn't matter
```

Keys are computed as sorted JSON, so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` are identical.

## Instance Object Examples

| Workflow                | Instance object                          | Description                          |
| ----------------------- | ---------------------------------------- | ------------------------------------ |
| `lead-qualification:1`  | `{ platform: "ka", listingId: "12345" }` | One listing per instance             |
| `lead-outreach:1`       | `{ leadId: 42, brokerId: 7 }`            | One outreach per lead+broker pair    |
| `daily-digest:1`        | `{ date: "2026-03-10", userId: 99 }`     | One digest per user per day          |

## Reruning an Instance

`engine.rerun(instanceId)` creates a **new run** under the same instance, copying the step state from the most recent run:

```ts
const newRunId = await engine.rerun(lead.workflowInstanceId);
```

What happens:
1. Looks up the latest run for this instance.
2. Creates a new run, copying the cached step results.
3. Returns the new `runId`.
4. The worker picks up the new run and replays the workflow — cached steps return instantly, `rerun: true` steps re-execute.

## Querying Runs for an Instance

```ts
// All runs for this instance (most recent first)
const runs = await engine.getRuns(instanceId);

// Just the most recent run
const latest = await engine.getLatestRun(instanceId);
```

Use `getLatestRun` to check the current state of a workflow instance without caring about history.

## Storing the Instance ID in Your Domain Tables

Because an instance represents a stable real-world entity, store `instanceId` (not `runId`) as the foreign key in your domain tables:

```ts
// After starting a workflow for a lead
const { instanceId } = await engine.run("lead-qualification:1", input, {
  instance: { platform: "ka", listingId: lead.listingId },
  queue: "leads",
});

await db.update(leads)
  .set({ workflowInstanceId: instanceId })
  .where(eq(leads.id, lead.id));
```

This lets you rerun the workflow later without looking up an run ID:

```ts
if (lead.workflowInstanceId) {
  const runId = await engine.rerun(lead.workflowInstanceId);
} else {
  const { instanceId } = await engine.run(...);
  await db.update(leads).set({ workflowInstanceId: instanceId })...;
}
```

## No Engine-Level Deduplication

The engine does **not** deduplicate runs. Calling `engine.run()` always creates a new run. Deduplication is the caller's responsibility via its own domain tables — check whether `lead.workflowInstanceId` is already set before calling `engine.run()`.

---

Next: [Queues & Concurrency](13-queues.md)
