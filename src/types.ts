export type LogLevel = "debug" | "info" | "warn" | "error";

export interface WorkflowLogEntry {
	level: LogLevel;
	message: string;
	meta?: Record<string, unknown>;
	stepKey?: string;
	createdAt: string;
}

export interface WorkflowInstance {
	id: number;
	/** Workflow function name, e.g. "lead-qualification:1" */
	name: string;
	/**
	 * JSON-serialized identity object. All runs with the same
	 * `name` + `instance` belong to the same logical workflow instance.
	 * Example: `{"platform":"ka","listingId":"12345"}`
	 */
	instance: string;
	createdAt: string;
}

export type RunStatus = "pending" | "running" | "sleeping" | "waiting" | "completed" | "failed" | "cancelled";

export interface WorkflowRun {
	id: number;
	/** References the workflow instance this run belongs to. */
	instanceId: number;
	status: RunStatus;
	input: string; // JSON-serialized input
	output: string | null;
	error: string | null;
	queue: string;
	parentRunId: number | null;
	attempts: number; // how many times this run has been attempted
	maxAttempts: number; // max attempts before permanent failure (default 1)
	/** Backoff strategy for run-level retries. Default: "exponential". */
	backoff: Backoff;
	/**
	 * Persistent workflow state — the single source of truth for all primitives.
	 * Contains typed buckets: step, memo, sleep, event, changed, diff, kv, state.
	 */
	state: Record<string, unknown>;
	claimedAt: string | null; // ISO 8601 — when the worker last claimed this run
	runAt: string; // ISO 8601 — when this run becomes eligible for claiming
	createdAt: string;
	updatedAt: string;
}

export type StepStatus = "completed" | "failed" | "fatal";

/**
 * A durable step entry stored in the `step` bucket of the run state.
 * Tracks status, result, retry attempts, timing, and ordering.
 */
export interface StepEntry {
	status: StepStatus;
	/** The step result as a native value (not JSON-serialized). Null on failure. */
	result: unknown;
	error: string | null;
	/** Total attempts including the first. Used for multi-dispatch retry budget. */
	attempts: number;
	/**
	 * Monotonically increasing sequence number within a run (1-indexed).
	 * Used for deterministic ordering.
	 */
	seq: number;
	/** When the step first ran (ISO 8601). */
	startedAt: string;
	/** When the step completed or failed (ISO 8601). */
	completedAt: string;
	/** Wall-clock execution time in milliseconds. Null for replayed steps. */
	durationMs: number | null;
	/** Set when a step is replayed from cache. Used for timeline ordering. */
	replayedAt: string | null;
}

/** A sleep entry stored in the `sleep` bucket. Presence = already slept. */
export interface SleepEntry {
	wakeAt: string; // ISO 8601
}

/** An event entry stored in the `event` bucket. */
export interface EventEntry {
	status: "waiting" | "delivered";
	token: string;
	data?: unknown;
}

/**
 * @deprecated Use `StepEntry` instead. This type is kept for backward
 * compatibility with API consumers that read step data from the old format.
 */
export interface WorkflowStep {
	id: number;
	runId: number;
	stepKey: string;
	seq: number;
	status: StepStatus;
	result: string | null; // JSON
	error: string | null;
	attempts: number;
	startedAt: string;
	completedAt: string;
	durationMs: number | null;
	replayedAt: string | null;
}

export type Backoff = "none" | "linear" | "exponential";

export interface StepOptions {
	/** Max total attempts including the first. Default: 1 (no retry). */
	maxAttempts?: number;
	/** Backoff between retry attempts. Default: "exponential". */
	backoff?: Backoff;
	/**
	 * "fail" (default): throw FatalError when all attempts exhausted.
	 * "complete": return undefined and continue workflow (fail-open).
	 */
	onAllAttemptsFailed?: "fail" | "complete";
	/**
	 * Step timeout. If the thunk does not resolve within this duration,
	 * it is aborted and treated as a retryable failure.
	 * Accepts milliseconds (number) or a duration string ("30s", "2m", "1h").
	 * Default: no timeout.
	 */
	timeout?: number | string;
	/**
	 * Force re-execution of this step even if a cached result exists.
	 * The thunk runs again and the stored result is overwritten.
	 * Use for dependency chains: when an upstream step reruns, pass
	 * `rerun: true` to downstream steps that depend on its fresh value.
	 * Default: false.
	 */
	rerun?: boolean;
}

export interface PollOptions {
	/** Async function that checks if the condition is met. Return { ready: true } to proceed, or { ready: false, retryAfterMs: N } to sleep and retry. */
	check: () => Promise<{ ready: true } | { ready: false; retryAfterMs: number }>;
	/** Minimum sleep duration in ms between checks. Default: 30000 (30s). */
	minIntervalMs?: number;
}

/**
 * Return type for step() and memo().
 * [0] data  — the step result (null when fail-open and all attempts failed)
 * [1] error — error message string (null on success)
 * [2] fresh — true if the thunk ran this time, false if replayed from cache
 */
export type StepResult<T> = [T, string | null, boolean];

export interface WorkflowContext {
	runId: number;
	instanceId: number;
	workflowName: string;
	step<T>(
		key: string,
		thunk: () => Promise<T>,
		opts: StepOptions & { onAllAttemptsFailed: "complete" },
	): Promise<StepResult<T | null>>;
	step<T>(key: string, thunk: () => Promise<T>, opts?: StepOptions): Promise<StepResult<T>>;
	/**
	 * Suspend the workflow for a duration.
	 * Duration strings: "30s" | "5m" | "2h" | "7d" | "1w" | "500ms"
	 * Also accepts a Date object — suspends until that point in time.
	 */
	waitForDuration(duration: string | Date, label?: string): Promise<void>;
	/**
	 * Suspend the workflow until a specific point in time.
	 * If the target time is already in the past, returns immediately.
	 */
	waitForDate(target: Date | string, label?: string): Promise<void>;
	/**
	 * Suspend the workflow until an external event is delivered.
	 *
	 * The token is auto-generated from `runId:eventName`, so callers
	 * only need the run ID and event name to deliver data:
	 *
	 *   engine.sendEvent(runId, "approval", { approved: true })
	 */
	waitForEvent<T = unknown>(eventName: string): Promise<T>;
	/**
	 * Poll until a condition is met. Each iteration creates a memo check
	 * and a sleep with auto-generated keys.
	 */
	poll(label: string, opts: PollOptions): Promise<void>;
	/**
	 * Memoize a pure computation for deterministic replay.
	 * Like step() but without retry/timeout/backoff options.
	 * Stores the raw value in the `memo` bucket.
	 */
	memo<T>(key: string, fn: () => Promise<T> | T, opts?: { rerun?: boolean }): Promise<StepResult<T>>;
	/**
	 * Persistent cross-run state variable.
	 *
	 * Returns a handle with `get()` and `set(value)`.
	 * - `get()` reads the value synchronously (from in-memory cache).
	 * - `set(value)` persists the value immediately.
	 *
	 * State survives across runs within the same instance —
	 * rerun copies state from the previous run.
	 */
	state<T>(key: string): WorkflowState<T>;
	/**
	 * Check whether a value has changed since the last run.
	 *
	 * Compares the current value against the previously stored value using
	 * deep JSON equality (with sorted keys for stable comparison).
	 * Returns `true` if the value differs or if this is the first call.
	 *
	 * Built on `rawState("changed", label)` internally.
	 */
	changed(label: string, value: unknown): Promise<boolean>;
	/**
	 * Compute a diff between the current array and the previously stored array.
	 *
	 * Returns `{ added, removed, kept }` where:
	 * - `added`: items in `currentItems` not present in the previous call
	 * - `removed`: keys that were present before but are missing now
	 * - `kept`: items in `currentItems` that were also present before
	 *
	 * `keyFn` extracts a unique string key from each item for comparison.
	 * Built on `rawState("diff", key)` internally.
	 */
	diff<T>(key: string, currentItems: T[], keyFn: (item: T) => string): Promise<DiffResult<T>>;
	/**
	 * Persistent key-value map scoped to a workflow instance.
	 *
	 * Returns a handle with `get`, `set`, `delete`, `entries`, `has`, `keys`.
	 * All reads are synchronous (from in-memory cache). Writes persist immediately.
	 *
	 * Useful for tracking child workflows, accumulating results, etc.
	 * Built on `rawState("kv", key)` internally.
	 */
	kv<T>(key: string): WorkflowKV<T>;
	/**
	 * Spawn a child workflow. Auto-links parentRunId from the current run.
	 * Durable — cached on replay via an auto-generated step key.
	 * Type-safe input checked against the workflow definition.
	 */
	runChild<TInput>(
		workflow: WorkflowDefinition<TInput, any>,
		input: TInput,
		opts: ChildRunOptions,
	): Promise<RunResult>;
	/**
	 * Re-run a child workflow instance. Creates a new run copying state
	 * from the latest run. Durable — cached on replay.
	 * Returns the new run ID.
	 */
	rerunChild(instanceId: number): Promise<number>;
	/** Append a structured log entry to the workflow run's log. */
	log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}

/** Handle for a persistent state variable. */
export interface WorkflowState<T> {
	/** Read the current value (synchronous, from in-memory cache). */
	get(): T | undefined;
	/** Persist a new value. */
	set(value: T): Promise<void>;
}

/** Result of `wf.diff()`. */
export interface DiffResult<T> {
	/** Items present now but not before. */
	added: T[];
	/** Keys that were present before but are missing now. */
	removed: string[];
	/** Items present both now and before. */
	kept: T[];
}

/** Handle for a persistent key-value map. */
export interface WorkflowKV<T> {
	/** Get a value by key (synchronous, from in-memory cache). */
	get(key: string): T | undefined;
	/** Set a value by key. Persists immediately. */
	set(key: string, value: T): Promise<void>;
	/** Delete a key. Persists immediately. */
	delete(key: string): Promise<void>;
	/** Check if a key exists. */
	has(key: string): boolean;
	/** Get all keys. */
	keys(): string[];
	/** Get all entries as [key, value] pairs. */
	entries(): [string, T][];
}

export type WorkflowFn<TInput = unknown, TOutput = unknown> = (input: TInput, wf: WorkflowContext) => Promise<TOutput>;

export interface RunOptions {
	/**
	 * Structured identity object for the workflow instance.
	 * All runs with the same `name` + `instance` belong to the same
	 * logical instance. Uniqueness is enforced by the storage layer.
	 *
	 * Examples:
	 *   { platform: "ka", listingId: "12345" }
	 *   { leadId: 42, brokerId: 7 }
	 */
	instance: Record<string, unknown>;
	queue?: string;
	runAt?: string;
	/**
	 * Parent run ID. Links this run as a child of another.
	 * Enables cascading cancellation: engine.cancel(parentId) cancels all
	 * non-terminal children recursively.
	 */
	parentRunId?: number;
	/**
	 * Max run-level attempts. If the workflow function throws an uncaught
	 * error (outside of any step), the run is re-scheduled up to this many
	 * times before being marked failed permanently.
	 * Default: 1 (no run-level retry — only step-level retries apply).
	 */
	maxAttempts?: number;
	/**
	 * Backoff strategy for run-level retries.
	 *   "none"        — 1s, 1s, 1s, …
	 *   "linear"      — 1s, 2s, 3s, 4s, …
	 *   "exponential" — 1s, 2s, 4s, 8s, 16s, … (default)
	 */
	backoff?: Backoff;
}

/** RunOptions without parentRunId — auto-set by runChild(). */
export type ChildRunOptions = Omit<RunOptions, "parentRunId">;

/**
 * Interface for dispatching child workflows from within a workflow context.
 * Passed to buildContext by the executor — decouples context from the engine.
 */
export interface ChildDispatcher {
	run(name: string, input: unknown, opts: RunOptions): Promise<RunResult>;
	rerun(instanceId: number): Promise<number>;
}

/** Result of engine.run() / workflow.run() — both the stable instance ID and the new run ID. */
export interface RunResult {
	instanceId: number;
	runId: number;
	/**
	 * True if an active (non-terminal) run already existed for this instance
	 * and no new run was created. `runId` points to the existing one.
	 */
	deduplicated: boolean;
}

export interface QueueConfig {
	concurrency?: number;
	pollIntervalMs?: number;
	/**
	 * How long a run can stay in "running" status before the worker
	 * considers it stale (crashed worker) and re-claims it. In milliseconds.
	 * Default: 300_000 (5 minutes).
	 */
	staleRunTimeoutMs?: number;
}

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

export interface LifecycleHooks {
	/** Called when the worker first picks up a run. */
	onRunStarted?(run: WorkflowRun): void | Promise<void>;
	/** Called after a run transitions to "completed". */
	onRunCompleted?(run: WorkflowRun): void | Promise<void>;
	/** Called after a run transitions to "failed" (permanently). */
	onRunFailed?(run: WorkflowRun, error: string): void | Promise<void>;
	/** Called after a step fails (before retry or exhaustion). */
	onStepFailed?(run: WorkflowRun, stepKey: string, error: string, attempt: number): void | Promise<void>;
	/** Called after a step completes successfully. */
	onStepCompleted?(run: WorkflowRun, stepKey: string, durationMs: number): void | Promise<void>;
	/** Called after a run is cancelled. */
	onRunCancelled?(run: WorkflowRun): void | Promise<void>;
}

// ── WorkflowStorage ─────────────────────────────────────────────────────────

export interface WorkflowStorage {
	/**
	 * Upsert a workflow instance. Returns the instance ID.
	 * If an instance with the same name + instance already exists, returns its ID.
	 * `instance` is the raw identity object — the storage layer handles serialization.
	 */
	upsertInstance(instance: { name: string; instance: Record<string, unknown> }): Promise<number>;

	/**
	 * Atomically create a new run for an instance, enforcing that at most
	 * one active (non-terminal) run exists per instance at any time.
	 *
	 * 1. Upserts the workflow instance (by name + instance).
	 * 2. Checks for any active run (status NOT IN completed/failed/cancelled).
	 * 3. If one exists → returns { instanceId, runId, deduplicated: true }.
	 * 4. Otherwise → inserts a new run and returns { ..., deduplicated: false }.
	 *
	 * The entire operation must be serialized per instance to prevent race conditions.
	 * PostgreSQL implementations should use SELECT ... FOR UPDATE or advisory locks.
	 */
	createRun(
		instance: { name: string; instance: Record<string, unknown> },
		run: Omit<WorkflowRun, "id" | "createdAt" | "updatedAt" | "instanceId">,
	): Promise<RunResult>;

	/**
	 * Claim the next batch of runnable runs for a given queue.
	 */
	claimPendingRuns(queue: string, limit: number, staleTimeoutMs: number): Promise<WorkflowRun[]>;

	completeRun(runId: number, output: unknown): Promise<void>;
	failRun(runId: number, error: string): Promise<void>;
	suspendRun(runId: number, reason: "sleep" | "hook", runAt: string): Promise<void>;
	cancelRun(runId: number): Promise<void>;
	/** Cancel all non-terminal children of a run (recursively). */
	cancelChildren(runId: number): Promise<void>;

	/**
	 * Create a new run for the same instance, copying state
	 * from the latest run. Returns the new run's ID.
	 */
	rerunInstance(instanceId: number): Promise<number>;

	/** Get a workflow instance by ID. */
	getInstance(instanceId: number): Promise<WorkflowInstance | null>;

	/** Get direct children of a run. */
	getChildren(runId: number): Promise<WorkflowRun[]>;
	/** Get a single run by ID. */
	getRun(runId: number): Promise<WorkflowRun | null>;
	/**
	 * Get the latest run for an instance.
	 * Returns null if the instance has no runs.
	 */
	getLatestRun(instanceId: number): Promise<WorkflowRun | null>;
	/** Get all runs for an instance, ordered by createdAt DESC. */
	getRuns(instanceId: number): Promise<WorkflowRun[]>;

	pendingCount(name: string): Promise<number>;

	/**
	 * Find a run that is waiting for a hook with the given token.
	 * Searches the `event` bucket in the state column.
	 */
	findRunWaitingForHook(token: string): Promise<WorkflowRun | null>;

	/**
	 * Deliver a hook signal to a run. Updates the event entry
	 * in the state column and sets the run back to pending.
	 */
	deliverHookSignal(runId: number, token: string, data: unknown): Promise<void>;

	/**
	 * Get the persistent state JSON for a run.
	 * Returns a parsed object (empty `{}` if no state set).
	 * This is the single source of truth — contains all buckets.
	 */
	getState(runId: number): Promise<Record<string, unknown>>;

	/**
	 * Replace the entire persistent state for a run.
	 * Called by rawState().set() — merges happen in the context layer.
	 */
	setState(runId: number, state: Record<string, unknown>): Promise<void>;

	/** Append a log entry to a workflow run. */
	appendLog?(runId: number, entry: WorkflowLogEntry): Promise<void>;
	/** Get all log entries for a workflow run. */
	getLogs?(runId: number): Promise<WorkflowLogEntry[]>;
}

// ── defineWorkflow ──────────────────────────────────────────────────────────

export interface WorkflowDefinitionConfig<TInput, TOutput> {
	name: string;
	handler: WorkflowFn<TInput, TOutput>;
}

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> {
	readonly name: string;
	readonly handler: WorkflowFn<TInput, TOutput>;
	run(engine: WorkflowEngine, input: TInput, opts: RunOptions): Promise<RunResult>;
}

// ── Engine ──────────────────────────────────────────────────────────────────

export interface EngineConfig {
	storage: WorkflowStorage;
	workflows: WorkflowDefinition<any, any>[];
	queues?: Record<string, QueueConfig>;
	defaultQueue?: string;
	/** Lifecycle hooks — called by the worker after state transitions. */
	hooks?: LifecycleHooks;
}

export interface WorkflowEngine {
	/**
	 * Run a new workflow. Upserts the instance and creates a new run.
	 * Returns both the stable instance ID and the new run ID.
	 */
	run(name: string, input: unknown, opts: RunOptions): Promise<RunResult>;

	/**
	 * Deliver an event to a waiting workflow run.
	 */
	sendEvent(runId: number, eventName: string, data: unknown): Promise<void>;

	/** Cancel a run and all its non-terminal children (recursively). */
	cancel(runId: number): Promise<void>;

	/**
	 * Re-run a workflow instance by creating a new run.
	 * Copies state from the latest run.
	 * Returns the new run's ID.
	 */
	rerun(instanceId: number): Promise<number>;

	pendingCount(name: string): Promise<number>;

	/** Get a workflow instance by ID. */
	getInstance(instanceId: number): Promise<WorkflowInstance | null>;

	/** Get direct children of a run. */
	getChildren(runId: number): Promise<WorkflowRun[]>;

	/** Get a single run by ID. */
	getRun(runId: number): Promise<WorkflowRun | null>;

	/** Get the latest run for an instance. */
	getLatestRun(instanceId: number): Promise<WorkflowRun | null>;

	/** Get all runs for an instance. */
	getRuns(instanceId: number): Promise<WorkflowRun[]>;

	/** Get persisted log entries for a workflow run. */
	getLogs(runId: number): Promise<WorkflowLogEntry[]>;

	/** Start worker loops. Returns a stop function for graceful shutdown. */
	start(): () => Promise<void>;
}
