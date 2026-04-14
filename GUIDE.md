# The Ultimate Guide to `@traumwohnung/workflow`

A durable workflow engine for TypeScript/Bun built on a single primitive: `rawState(type, key)`. Designed for multi-step business processes that must survive crashes, wait for external events, and retry failures — all backed by one JSONB column in PostgreSQL.

---

## Table of Contents

### Getting Started

- [Core Concepts](docs/01-core-concepts.md) — Workflows, Instances, Runs, State buckets, `rawState` primitive, replay model
- [Quick Start](docs/02-quick-start.md) — Install, minimal example, naming conventions

### Workflow Primitives

All primitives are built on `rawState(type, key)` and store data in typed buckets within a single JSONB column.

- [Steps](docs/03-steps.md) — Durable side effects: `step` bucket, options, `StepResult` tuples, type-safe fail-open
- [Retry & Backoff](docs/04-retry-and-backoff.md) — Automatic retries with configurable strategies
- [Rerun & Change Detection](docs/05-rerun-and-changed.md) — `rerun` option, `changed()`, `state()`, `diff()`, `kv()`, dependency chains
- [Sleeping](docs/06-sleeping.md) — `waitForDuration()`, `waitForDate()`: own `sleep` bucket, duration units, labels
- [Polling](docs/07-polling.md) — `poll()` check-sleep loops using `memo()` + `waitForDuration()`
- [Memoization](docs/08-memoization.md) — `memo()`: own `memo` bucket, lightweight deterministic replay
- [Events](docs/09-events.md) — `waitForEvent()`, `sendEvent()`: own `event` bucket, webhook-style API
- [Structured Logging](docs/10-logging.md) — `wf.log()` persistent audit trail

### Orchestration

- [Parent–Child Workflows](docs/11-parent-child.md) — Fan-out, cascading cancellation
- [Instances & Identity](docs/12-instances.md) — Instance model, instanceKey, stable references, rerun
- [Queues & Concurrency](docs/13-queues.md) — Named queues, polling, stale run recovery
- [Run-Level Retries](docs/14-run-retries.md) — Safety net for uncaught errors

### Engine

- [Lifecycle Hooks](docs/15-lifecycle-hooks.md) — `onRunStarted`, `onStepCompleted`, etc.
- [Cancel & Rerun](docs/16-cancel-and-rerun.md) — Cancel runs, rerun instances with rerun/changed()
- [Error Handling](docs/17-error-handling.md) — `FatalError`, `RetryableError`, decision tree

### Reference

- [Storage Implementation](docs/18-storage.md) — Single JSONB column schema, key operations, custom storage
- [State Machines](docs/19-state-machines.md) — Run and step lifecycle diagrams
- [API Reference](docs/20-api-reference.md) — Complete engine + context API with bucket mapping
- [Patterns & Recipes](docs/21-patterns.md) — 12 real-world patterns with code examples
- [CLI & REST API](docs/22-cli-and-rest.md) — Observability, event delivery endpoint
- [Testing](docs/23-testing.md) — In-memory storage, test harness, state seeding
