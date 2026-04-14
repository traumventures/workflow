# Quick Start

## Install

The package is a workspace dependency:

```json
{
  "dependencies": {
    "@traumwohnung/workflow": "workspace:*"
  }
}
```

## Minimal Example

```ts
import { createEngine, type WorkflowFn } from "@traumwohnung/workflow";
import { pgStorage } from "./my-storage"; // implements WorkflowStorage

// 1. Create the engine
const engine = createEngine({
  storage: pgStorage,
  queues: {
    default: { concurrency: 10, pollIntervalMs: 1_000 },
  },
});

// 2. Define a workflow
const myWorkflow: WorkflowFn<{ url: string }, { title: string }> = async (
  input,
  ctx,
) => {
  const [html] = await wf.step("fetch", async () => {
    const res = await fetch(input.url);
    return res.text();
  });

  const [title] = await wf.step("parse", async () => {
    const match = html.match(/<title>(.*?)<\/title>/);
    return match?.[1] ?? "Untitled";
  });

  return { title };
};

// 3. Register it
engine.register_REMOVED("scrape-page:1", myWorkflow);

// 4. Start the worker loop
const stopEngine = engine.run();

// 5. Enqueue an run
const { instanceId, runId } = await engine.run("scrape-page:1", {
  input: { url: "https://example.com" },
  instance: { url: "https://example.com" },
});

console.log("Enqueued run:", runId, "(instance:", instanceId, ")");

// Later: graceful shutdown
// await stopEngine();
```

## Naming Convention

Workflow names include a version suffix (`:1`, `:2`, etc.) so you can deploy new versions alongside old ones without breaking in-flight runs.

---

Next: [Steps](03-steps.md)
