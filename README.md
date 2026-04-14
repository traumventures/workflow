# @traumwohnung/workflow

A lightweight, durable workflow engine for TypeScript and Bun. Zero external dependencies — just your code, your database, and rock-solid step-by-step run that survives crashes.

## Why

Long-running business processes — scraping pipelines, outreach sequences, approval flows — shouldn't die when your server restarts. This engine gives you **durable run** with a simple function-based API: write normal async code, wrap side effects in `wf.step()`, and the engine handles persistence, retries, timeouts, and replay.

## Features

- **Single state primitive** — All workflow data lives in one JSONB column with typed buckets (`step`, `memo`, `sleep`, `event`, `changed`, `diff`, `kv`, `state`). Every primitive is built on one internal function: `rawState(type, key)`.

- **Durable steps** — Each step's result is persisted as native JSONB. On replay (after crash, sleep, or signal), completed steps return their stored result instantly — your thunk is never called twice.

- **Automatic retries with backoff** — Steps can retry with `none`, `linear`, or `exponential` backoff. Configure `maxAttempts`, `timeout`, and whether exhaustion kills the run or continues gracefully.

- **Type-safe fail-open steps** — `onAllAttemptsFailed: "complete"` returns `StepResult<T | null>` — destructure as `[data, error, fresh]`, no manual type assertions needed.

- **Sleep** — `await wf.waitForDuration("7d")` suspends the workflow for days with zero CPU cost. Stored in its own `sleep` bucket. Also accepts `Date` objects and supports `ms`/`s`/`m`/`h`/`d`/`w` duration units.

- **Sleep until** — `await wf.waitForDate(targetDate)` suspends until a concrete timestamp. Returns immediately if the time has already passed.

- **Polling** — `await wf.poll("label", { check })` provides a first-class check-sleep loop using `memo()` + `waitForDuration()` — no more boilerplate `while(true)` patterns.

- **Memoization** — `await wf.memo("key", fn)` memoizes pure computations in its own `memo` bucket — lightweight, no step overhead. Returns a `[data, error, fresh]` tuple.

- **Events (external signals)** — `await wf.waitForEvent("event")` pauses the workflow until `engine.sendEvent(runId, "event", data)` delivers a result. Stored in the `event` bucket. Perfect for webhooks, human approval, or delivery confirmations.

- **Persistent state** — `wf.state()`, `wf.kv()`, `wf.diff()` for cross-run state that survives reruns. Each has its own bucket in the JSONB column.

- **Structured step results** — `step()` and `memo()` return `[data, error, fresh]` tuples for clean destructuring. Grab just the data, check errors on fail-open steps, or detect freshness.

- **Auto-logging** — The engine auto-logs step replay/completion/failure, sleep suspension, poll start/ready, and change detection. Workflows only need business-level logs.

- **Structured logging** — `wf.log("info", "message", { meta })` persists structured log entries alongside the run, visible in the API and CLI.

- **Parent–child workflows** — Fan out from one workflow to many. Cancelling a parent cascades to all children recursively.

- **Instances & identity** — `engine.run()` upserts a stable **instance** (identified by workflow name + instance object) and always creates a new run under it. Store the `instanceId` in your domain tables as a stable reference that survives reruns.

- **Rerun by instance** — `engine.rerun(instanceId)` creates a new run copying the state from the latest one. The workflow's `rerun`/`changed()` logic decides what to re-execute, so expensive work (LLM calls, API fetches) is never repeated unnecessarily.

- **Queues with configurable concurrency** — Route workflows to named queues (`leads`, `email`, `default`) with independent concurrency limits and poll intervals.

- **Lifecycle hooks** — React to `onRunStarted`, `onRunCompleted`, `onRunFailed`, `onStepCompleted`, `onStepFailed`, and `onRunCancelled` for logging, metrics, or alerting.

- **Step duration tracking** — Every step records its wall-clock run time (`durationMs`), enabling performance monitoring via `onStepCompleted` hooks.

- **Cancel & rerun** — Cancel an run (+ children) in one call, or **rerun** a workflow instance — step cache is preserved and the workflow's `rerun`/`changed()` logic decides what to re-execute.

- **Pluggable storage** — Implements a clean `WorkflowStorage` interface with just `getState`/`setState` as the core persistence path. Ships with a PostgreSQL/Drizzle implementation; swap in SQLite, Turso, or an in-memory mock for tests.

## Quick Example

```ts
import { createEngine } from "@traumwohnung/workflow";

const engine = createEngine({ storage: pgStorage });

engine.register_REMOVED("onboard-user:1", async (input, wf) => {
  const [user] = await wf.step("create-account", () => createAccount(input.email));

  await wf.step("send-welcome", () => sendEmail(user.id, "Welcome!"));

  wf.log("info", "Welcome email sent", { userId: user.id });

  await wf.waitForDuration("3d");

  await wf.step("send-followup", () => sendEmail(user.id, "How's it going?"));

  const feedback = await wf.waitForEvent<{ rating: number }>("feedback");

  await wf.step("store-feedback", () => saveFeedback(user.id, feedback.rating));

  return { userId: user.id, rating: feedback.rating };
});

const stop = engine.run();
const { instanceId, runId } = await engine.run(
  "onboard-user:1",
  { email: "hello@example.com" },
  { instance: { email: "hello@example.com" } },
);

// Later — inspect the run
const run = await engine.getRun(runId);
```

## Full Documentation

**→ [GUIDE.md](./GUIDE.md)** — Table of contents linking to all docs.

**→ [docs/](./docs/)** — Individual guides covering every feature:

| Guide | Topics |
|-------|--------|
| [Core Concepts](docs/01-core-concepts.md) | Workflows, Instances, Runs, Steps, State, Storage, replay model |
| [Steps](docs/03-steps.md) | Durability, options, `StepResult` tuples, type-safe fail-open |
| [Rerun & Change Detection](docs/05-rerun-and-changed.md) | `rerun`, `changed()`, `state()`, `diff()`, `kv()`, dependency chains |
| [Events](docs/09-events.md) | `waitForEvent()`, `sendEvent()`, webhook API |
| [Instances & Identity](docs/12-instances.md) | Instance model, instanceKey, rerun |
| [Patterns & Recipes](docs/21-patterns.md) | 12 real-world patterns with code |
| [API Reference](docs/20-api-reference.md) | Complete engine + context API |
