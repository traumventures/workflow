# Parent–Child Workflows

Workflows can spawn child workflows. This enables:

- **Decomposition:** A qualification workflow spawns N outreach workflows (one per broker).
- **Cascading cancellation:** Cancelling the parent cancels all children recursively.
- **Independent retries:** Each child has its own step state, retries, and failure semantics.

## Spawning Children

```ts
const qualificationWorkflow: WorkflowFn = async (input, wf) => {
  // ... qualification steps ...

  for (const broker of matchedBrokers) {
    await wf.step(`spawn:${broker.id}`, () =>
      engine.run(
        "lead-outreach:1",
        {
          leadId: input.leadId,
          brokerId: broker.id,
        },
        {
          instance: { leadId: input.leadId, brokerId: broker.id },
          queue: "leads",
          parentRunId: wf.runId,  // ← links as child
        },
      ),
    );
  }

  return { brokerCount: matchedBrokers.length };
};
```

## Key Points

- **`parentRunId`** in `RunOptions` establishes the parent–child relationship.
- Wrapping `engine.run()` in a `wf.step()` makes the spawn idempotent — on replay, the already-created child run ID is returned from the stored step result.
- `engine.cancel(runId)` cancels the run and all non-terminal children recursively (using a recursive CTE).
- `engine.getChildren(runId)` returns the direct child runs.

## Child Runs Are Independent

Child workflows:

- Have their own step state and retry counts.
- Run in whatever queue they're assigned to.
- Can complete, fail, or be cancelled independently of the parent.
- Do NOT block the parent — the parent completes after spawning. Use events if you need to wait for child completion.

---

Next: [Instances & Identity](12-instances.md)
