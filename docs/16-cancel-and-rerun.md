# Cancel & Rerun

## Cancel

```ts
await engine.cancel(runId);
```

- Sets the run's status to `"cancelled"` (only if currently non-terminal).
- **Recursively cancels all non-terminal children** using a recursive CTE.
- Fires `onRunCancelled` lifecycle hook.

Cancellation is **cooperative** — it only changes the DB status. If the workflow function is currently executing (in the middle of a step), it will finish that step and then the run won't be re-claimed (because it's no longer `pending`/`running`).

## Rerun

```ts
const runId = await engine.rerun(instanceId);
```

Creates a **new run** under the given instance, copying step state from the most recent run so the worker picks it up and replays the workflow. **All cached steps are preserved** — the workflow's own `rerun`/`changed()` logic decides what to re-execute.

What happens:
1. Looks up the latest run for this instance.
2. Creates a new run, copying the cached step results.
3. Returns the new `runId`.
4. The worker claims the new run and replays the workflow function.
5. Steps with cached results return instantly (no re-run).
6. Steps with `rerun: true` or driven by `changed()` re-execute.

### Why Not Delete Steps?

The old approach (`replayFrom`) deleted steps from a certain point onward and re-ran everything after. This was a blunt instrument:

- The caller had to know the step structure of the workflow.
- It destroyed cached state unnecessarily.
- It couldn't selectively re-execute — it was all-or-nothing from a certain point.

With `rerun`, the workflow itself is the single source of truth. The `rerun` option and `changed()` primitive give the workflow fine-grained control over what re-executes:

```ts
const workflow: WorkflowFn = async (input, wf) => {
  // Always re-fetch (get latest data from the source)
  const [listing] = await wf.step("fetch", () => fetchListing(input.id), { rerun: true });

  // Only re-process if the data actually changed
  const listingChanged = await wf.changed("listing", listing);

  const [filtered] = await wf.step("filter", () => filter(listing), { rerun: listingChanged });
  const [matched] = await wf.step("match", () => matchBrokers(filtered), { rerun: listingChanged });

  return { matchCount: matched.length };
};
```

When reruned:
- `fetch` always re-executes (gets latest data).
- `changed("listing", ...)` returns `true` only if the listing data differs from last time.
- If unchanged: `filter` and `match` return cached results instantly — no LLM calls, no API fetches.
- If changed: `filter` and `match` re-execute with fresh data.

### Rerun vs Start

| Method | When to use |
|--------|-------------|
| `engine.rerun(instanceId)` | Instance already exists — re-run with cached state |
| `engine.run(name, input, opts)` | No existing instance — create a new one |

A common pattern in routes:

```ts
if (lead.workflowInstanceId) {
  const runId = await engine.rerun(lead.workflowInstanceId);
} else {
  const { instanceId } = await engine.run("lead-qualification:1", input, {
    instance: { platform: lead.platform, listingId: lead.listingId },
    queue: "leads",
  });
  await db.update(leads).set({ workflowInstanceId: instanceId }).where(eq(leads.id, lead.id));
}
```

---

Next: [Error Handling](17-error-handling.md)
