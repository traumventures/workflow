import { computeBackoffMs } from "./backoff";
import { addDuration, now, parseDuration } from "./duration";
import { FatalError, StepTimeoutError, SuspendSignal } from "./errors";
import type {
	ChildDispatcher,
	ChildRunOptions,
	DiffResult,
	EventEntry,
	LogLevel,
	PollOptions,
	RunResult,
	SleepEntry,
	StepEntry,
	StepOptions,
	StepResult,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowKV,
	WorkflowState,
	WorkflowStorage,
} from "./types";

/**
 * In-memory state cache for a single run.
 * Loaded once at context build time, written back to storage on every mutation.
 * Contains all typed buckets: step, memo, sleep, event, changed, diff, kv, state.
 */
export interface StateCache {
	data: Record<string, unknown>;
}

/**
 * JSON.stringify replacer that sorts object keys for stable serialization.
 * Ensures { a: 1, b: 2 } and { b: 2, a: 1 } produce the same string.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
		);
	}
	return value;
}

/**
 * Retry info set by a failed step so the executor knows how long to wait
 * before rescheduling the execution.
 */
export interface RetryInfo {
	stepKey: string;
	backoffMs: number;
}

export interface StepCompletion {
	stepKey: string;
	durationMs: number;
}

export interface BuildContextResult {
	wf: WorkflowContext;
	/** Read the most recent retry info (if any) set by a failed step. */
	consumeRetryInfo: () => RetryInfo | null;
	/** Steps that completed successfully during this run (not replayed). */
	completedSteps: StepCompletion[];
}

// ── Build context ────────────────────────────────────────────────────────────

export function buildContext(
	runId: number,
	instanceId: number,
	workflowName: string,
	storage: WorkflowStorage,
	stateCache: StateCache = { data: {} },
	childDispatcher?: ChildDispatcher,
): BuildContextResult {
	// Per-context retry info — safe for concurrent workflow executions
	let lastRetryInfo: RetryInfo | null = null;

	// Tracks steps completed during this run (not replayed)
	const completedSteps: StepCompletion[] = [];

	// Counter for disambiguating multiple unlabeled sleeps
	let sleepCounter = 0;

	// Tracks the currently-executing step key for log attribution
	let currentStepKey: string | null = null;

	// ── rawState() — the single root primitive ─────────────────────────────
	// Every other primitive (step, memo, sleep, event, changed, diff, kv, state)
	// is built on top of this. It reads/writes to a typed bucket in stateCache.

	function rawState<T>(type: string, key: string): WorkflowState<T> {
			return {
			get(): T | undefined {
				const bucket = stateCache.data[type] as Record<string, unknown> | undefined;
				return bucket?.[key] as T | undefined;
			},
			async set(value: T): Promise<void> {
				let bucket = stateCache.data[type] as Record<string, unknown> | undefined;
				if (!bucket) {
					bucket = {};
					stateCache.data[type] = bucket;
				}
				bucket[key] = value;
				await storage.setState(runId, stateCache.data);
			},
		};
	}

	// ── Derive step map from state for seq counter ─────────────────────────

	const stepBucket = (stateCache.data.step ?? {}) as Record<string, StepEntry>;
	const stepSeqs = Object.values(stepBucket).map((s) => s.seq);
	const nextSeq = {
		value: stepSeqs.length > 0 ? Math.max(...stepSeqs) + 1 : 1,
	};

	// ── step() ──────────────────────────────────────────────────────────

	async function step<T>(
		key: string,
		thunk: () => Promise<T>,
		opts: StepOptions & { onAllAttemptsFailed: "complete" },
	): Promise<StepResult<T | null>>;
	async function step<T>(key: string, thunk: () => Promise<T>, opts?: StepOptions): Promise<StepResult<T>>;
	async function step<T>(key: string, thunk: () => Promise<T>, opts: StepOptions = {}): Promise<StepResult<T>> {
		const {
			maxAttempts = 1,
			backoff = "exponential",
			onAllAttemptsFailed = "fail",
			timeout: rawTimeout,
			rerun = false,
		} = opts;
		const timeout =
			rawTimeout == null ? undefined : typeof rawTimeout === "string" ? parseDuration(rawTimeout) : rawTimeout;

		const s = rawState<StepEntry>("step", key);
		let existing = s.get();

		// Rerun: discard cached state so the thunk re-executes with fresh data.
		// Preserve the existing seq so ordering remains stable.
		const existingSeq = existing?.seq;
		if (rerun && existing) {
			existing = undefined;
		}

		// Replay: already completed → return stored result
		if (existing?.status === "completed") {
			// Stamp replayedAt so the UI can sort cached steps at their replay
			// position rather than their original startedAt.
			await s.set({ ...existing, replayedAt: now() });
			if (existing.result == null) {
				return [undefined as T, null, false];
			}
			return [existing.result as T, null, false];
		}

		// Permanently failed → throw (unless the caller asked for fail-open)
		if (existing?.status === "fatal") {
			if (onAllAttemptsFailed === "complete") {
				log("warn", `Step "${key}" permanently failed (fail-open): ${existing.error}`);
				return [null, existing.error ?? "unknown error", false] as unknown as StepResult<T>;
			}
			throw new FatalError(`Step "${key}" permanently failed: ${existing.error}`);
		}

		// Retry budget exhausted (replay guard — execution woke from sleep but retries are gone)
		const attempts = existing?.attempts ?? 0;
		if (existing?.status === "failed" && attempts >= maxAttempts) {
			if (onAllAttemptsFailed === "complete") {
				log("warn", `Step "${key}" exhausted ${maxAttempts} attempt(s) (fail-open): ${existing.error}`);
				return [null, existing.error ?? "unknown error", false] as unknown as StepResult<T>;
			}
			throw new FatalError(`Step "${key}" exhausted ${maxAttempts} attempt(s): ${existing.error}`);
		}

		// Execute thunk (with optional timeout)
		const startedAt = now();
		const startTime = performance.now();
		currentStepKey = key;
		const seq = existing?.seq ?? existingSeq ?? nextSeq.value++;
		try {
			let result: T;
			if (timeout != null && timeout > 0) {
				result = await Promise.race([
					thunk(),
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new StepTimeoutError(`Step "${key}" timed out after ${timeout}ms`)),
							timeout,
						),
					),
				]);
			} else {
				result = await thunk();
			}

			const durationMs = Math.round(performance.now() - startTime);
			await s.set({
				status: "completed",
				result,
				error: null,
				attempts: attempts + 1,
				seq,
				startedAt,
				completedAt: now(),
				durationMs,
				replayedAt: null,
			});
			currentStepKey = null;
			completedSteps.push({ stepKey: key, durationMs });
			return [result, null, true];
		} catch (err) {
			if (err instanceof SuspendSignal) throw err;

			const durationMs = Math.round(performance.now() - startTime);
			const isFatal = err instanceof FatalError;
			const errorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			const newAttempts = attempts + 1;
			const stepStatus: "failed" | "fatal" = isFatal || newAttempts >= maxAttempts ? "fatal" : "failed";

			await s.set({
				status: stepStatus,
				result: null,
				error: errorMsg,
				attempts: newAttempts,
				seq,
				startedAt,
				completedAt: now(),
				durationMs,
				replayedAt: null,
			});
			currentStepKey = null;

			if (stepStatus === "fatal") {
				log("error", `Step "${key}" failed permanently`, {
					error: errorMsg,
					attempts: newAttempts,
					durationMs,
				});
			} else {
				log("warn", `Step "${key}" failed (attempt ${newAttempts}/${maxAttempts})`, {
					error: errorMsg,
					durationMs,
				});
			}

			if (isFatal) throw err;
			if (newAttempts >= maxAttempts) {
				if (onAllAttemptsFailed === "complete") return [null, errorMsg, true] as unknown as StepResult<T>;
				throw new FatalError(`Step "${key}" exhausted ${maxAttempts} attempt(s): ${errorMsg}`);
			}

			lastRetryInfo = {
				stepKey: key,
				backoffMs: computeBackoffMs(backoff, newAttempts),
			};
			throw err;
		}
	}

	// ── memo() — own bucket, no step delegation ─────────────────────────

	async function memo<T>(key: string, fn: () => Promise<T> | T, opts?: { rerun?: boolean }): Promise<StepResult<T>> {
		const memoBucket = stateCache.data.memo as Record<string, unknown> | undefined;
		const hasCached = memoBucket !== undefined && key in memoBucket;

		if (hasCached && !opts?.rerun) {
			return [memoBucket![key] as T, null, false];
		}

		const result = await fn();
		const s = rawState<T>("memo", key);
		await s.set(result);
		return [result, null, true];
	}

	// ── waitForDuration() — own bucket ─────────────────────────────────────

	async function waitForDuration(duration: string | Date, label?: string): Promise<void> {
		// If Date, convert to a duration string from now
		if (duration instanceof Date) {
			const deltaMs = Math.max(0, duration.getTime() - Date.now());
			if (deltaMs === 0) return;
			const deltaSec = Math.max(1, Math.ceil(deltaMs / 1000));
			duration = `${deltaSec}s`;
		}

		const key = label ?? String(sleepCounter++);
		const s = rawState<SleepEntry>("sleep", key);

		if (s.get()) {
			log("debug", `Sleep "${label ?? key}" already elapsed`);
			return; // already slept
		}

		const wakeAt = addDuration(now(), duration);
		log("debug", `Sleeping for ${duration}`, {
			label: label ?? undefined,
			wakeAt,
		});
		await s.set({ wakeAt });
		throw new SuspendSignal("sleep", wakeAt, key);
	}

	// ── waitForDate() ──────────────────────────────────────────────────────

	async function waitForDate(target: Date | string, label?: string): Promise<void> {
		const targetMs = typeof target === "string" ? new Date(target).getTime() : target.getTime();
		const deltaMs = Math.max(0, targetMs - Date.now());
		if (deltaMs === 0) {
			log("debug", `Sleep until "${label ?? target}" already in the past — skipping`);
			return;
		}
		const targetIso = typeof target === "string" ? target : target.toISOString();
		log("debug", `Sleeping until ${targetIso}`, { label: label ?? undefined });
		const deltaSec = Math.max(1, Math.ceil(deltaMs / 1000));
		await waitForDuration(`${deltaSec}s`, label ?? `__until:${targetMs}`);
	}

	// ── waitForEvent() — own bucket ────────────────────────────────────────

	function waitForEvent<T = unknown>(eventName: string): Promise<T> {
		const token = `${runId}:${eventName}`;
		const s = rawState<EventEntry>("event", token);
		const existing = s.get();

		// Signal already delivered → return data
		if (existing?.status === "delivered") {
			log("debug", `Event "${token}" already delivered`);
			return Promise.resolve(existing.data as T);
		}

		// Register hook and suspend
		return (async (): Promise<never> => {
			if (!existing) {
				log("debug", `Waiting for event "${token}"`);
				await s.set({ status: "waiting", token });
			}
			throw new SuspendSignal("hook", null, token);
		})() as unknown as Promise<T>;
	}

	// ── poll() — uses useMemo() + waitForDuration() ─────────────────────

	async function poll(label: string, opts: PollOptions): Promise<void> {
		const minInterval = opts.minIntervalMs ?? 30_000;
		let attempt = 0;
		log("debug", `Poll "${label}" started`);
		while (true) {
			const [result] = await memo(`poll:${label}:${attempt}`, opts.check);
			if (result.ready) {
				log("debug", `Poll "${label}" ready after ${attempt + 1} check(s)`);
				return;
			}
			const waitMs = Math.max(minInterval, result.retryAfterMs);
			const waitSec = Math.max(1, Math.ceil(waitMs / 1000));
			await waitForDuration(`${waitSec}s`, `poll:${label}:${attempt}`);
			attempt++;
		}
	}

	// ── state() — built on rawState ─────────────────────────────────────

	function state<T>(key: string): WorkflowState<T> {
		return rawState<T>("state", key);
	}

	// ── changed() — built on rawState ───────────────────────────────────

	async function changed(label: string, value: unknown): Promise<boolean> {
		const s = rawState<unknown>("changed", label);
		const prev = s.get();
		const didChange =
			prev === undefined ||
			JSON.stringify(prev, sortedReplacer) !== JSON.stringify(value, sortedReplacer);
		await s.set(value);
		log(
			"debug",
			didChange
				? `Changed "${label}": ${prev === undefined ? "new value" : "value differs"}`
				: `Changed "${label}": unchanged`,
		);
		return didChange;
	}

	// ── diff() — built on rawState ──────────────────────────────────────

	async function diff<T>(key: string, currentItems: T[], keyFn: (item: T) => string): Promise<DiffResult<T>> {
		const s = rawState<string[]>("diff", key);
		const prevKeys = new Set(s.get() ?? []);
		const currentKeys = currentItems.map(keyFn);
		const currentKeySet = new Set(currentKeys);

		const added: T[] = [];
		const kept: T[] = [];
		for (let i = 0; i < currentItems.length; i++) {
			if (prevKeys.has(currentKeys[i])) {
				kept.push(currentItems[i]);
			} else {
				added.push(currentItems[i]);
			}
		}

		const removed: string[] = [];
		for (const k of prevKeys) {
			if (!currentKeySet.has(k)) {
				removed.push(k);
			}
		}

		await s.set(currentKeys);
		log("debug", `Diff "${key}"`, {
			added: added.length,
			removed: removed.length,
			kept: kept.length,
		});
		return { added, removed, kept };
	}

	// ── kv() — built on rawState ────────────────────────────────────────

	function kv<T>(key: string): WorkflowKV<T> {
		const s = rawState<Record<string, T>>("kv", key);

		function getMap(): Record<string, T> {
			return s.get() ?? {};
		}

		async function persistMap(map: Record<string, T>): Promise<void> {
			await s.set(map);
		}

			return {
			get(k: string): T | undefined {
				return getMap()[k];
			},
			async set(k: string, value: T): Promise<void> {
				const map = { ...getMap(), [k]: value };
				await persistMap(map);
			},
			async delete(k: string): Promise<void> {
				const map = { ...getMap() };
				delete map[k];
				await persistMap(map);
			},
			has(k: string): boolean {
				return k in getMap();
			},
			keys(): string[] {
				return Object.keys(getMap());
			},
			entries(): [string, T][] {
				return Object.entries(getMap());
			},
		};
	}

	// ── runChild() / rerunChild() ──────────────────────────────────────────

	async function runChild<TInput>(
		workflow: WorkflowDefinition<TInput, any>,
		input: TInput,
		opts: ChildRunOptions,
	): Promise<RunResult> {
		if (!childDispatcher) {
			throw new Error("runChild() requires an engine — not available in test context");
		}
		const instanceKey = JSON.stringify(opts.instance, sortedReplacer);
		const stepKey = `child:${workflow.name}:${instanceKey}`;
		const [result] = await step(stepKey, () =>
			childDispatcher.run(workflow.name, input, { ...opts, parentRunId: runId }),
		);
		return result;
	}

	async function rerunChild(childInstanceId: number): Promise<number> {
		if (!childDispatcher) {
			throw new Error("rerunChild() requires an engine — not available in test context");
		}
		const stepKey = `rerun:${childInstanceId}`;
		const [result] = await step(stepKey, () => childDispatcher.rerun(childInstanceId));
		return result;
	}

	// ── log() ──────────────────────────────────────────────────────────────

	function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
		// Debug logs are engine-internal — don't persist to DB.
		if (level === "debug") return;
		if (storage.appendLog) {
			storage
				.appendLog(runId, {
					level,
					message,
					meta,
					stepKey: currentStepKey ?? undefined,
					createdAt: now(),
				})
				.catch(() => {}); // fire-and-forget, never block workflow execution
		}
	}

	// ── Return ─────────────────────────────────────────────────────────────

	const wf: WorkflowContext = {
		runId,
		instanceId,
		workflowName,
		step,
		waitForDuration,
		waitForDate,
		waitForEvent,
		poll,
		memo,
		state,
		changed,
		diff,
		kv,
		runChild,
		rerunChild,
		log,
	};

	return {
		wf,
		consumeRetryInfo(): RetryInfo | null {
			const info = lastRetryInfo;
			lastRetryInfo = null;
			return info;
		},
		completedSteps,
	};
}
