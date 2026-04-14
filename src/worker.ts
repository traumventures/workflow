import { computeBackoffMs } from "./backoff";
import { addDuration, now } from "./duration";
import { executeWorkflow } from "./executor";
import type { ChildDispatcher, LifecycleHooks, QueueConfig, WorkflowFn, WorkflowRun, WorkflowStorage } from "./types";

const FAR_FUTURE = "2124-01-01T00:00:00.000Z";
const DEFAULT_STALE_TIMEOUT_MS = 300_000; // 5 minutes

export interface WorkerLoopConfig extends Required<QueueConfig> {
	staleRunTimeoutMs: number;
}

export class WorkerLoop {
	private stopped = false;
	private inflight = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly queue: string,
		private readonly config: WorkerLoopConfig,
		private readonly storage: WorkflowStorage,
		private readonly registry: Map<string, WorkflowFn>,
		private readonly hooks: LifecycleHooks,
		private readonly childDispatcher: ChildDispatcher,
	) {}

	start(): () => Promise<void> {
		this.tick();
		return () => this.stop();
	}

	private async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		const deadline = Date.now() + 30_000;
		while (this.inflight > 0 && Date.now() < deadline) {
			await new Promise<void>((r) => setTimeout(r, 50));
		}
	}

	private tick(): void {
		if (this.stopped) return;
		this.poll()
			.catch((err) => console.error(`[workflow] Worker poll error (${this.queue}):`, err))
			.finally(() => {
				if (!this.stopped) {
					this.timer = setTimeout(() => this.tick(), this.config.pollIntervalMs);
				}
			});
	}

	private async poll(): Promise<void> {
		const available = this.config.concurrency - this.inflight;
		if (available <= 0) return;
		const runs = await this.storage.claimPendingRuns(this.queue, available, this.config.staleRunTimeoutMs);
		if (runs.length === 0) return;
		for (const run of runs) {
			this.inflight++;
			this.dispatch(run)
				.catch((err) => {
					console.error(`[workflow] Dispatch error (${this.queue}) for run ${run.id}:`, err);
				})
				.finally(() => {
					this.inflight--;
				});
		}
	}

	private async dispatch(run: WorkflowRun): Promise<void> {
		const instance = await this.storage.getInstance(run.instanceId);
		if (!instance) {
			console.warn(`[workflow] Instance ${run.instanceId} not found for run ${run.id}`);
			return;
		}
		const fn = this.registry.get(instance.name);
		if (!fn) {
			console.warn(`[workflow] No handler for "${instance.name}" — rescheduling run ${run.id} in 30s`);
			await this.storage.suspendRun(run.id, "sleep", addDuration(now(), "30s"));
			return;
		}
		await this.invokeHook(() => this.hooks.onRunStarted?.(run));
		const result = await executeWorkflow(run, instance.name, fn, this.storage, this.childDispatcher);
		for (const sc of result.completedSteps) {
			await this.invokeHook(() => this.hooks.onStepCompleted?.(run, sc.stepKey, sc.durationMs));
		}
		// Wrap every post-run storage transition. A DB error here must not
		// leave the run stuck in "running" — the stale-run reclaim will
		// re-dispatch it once the timeout elapses.
		try {
			switch (result.outcome) {
				case "completed":
					await this.storage.completeRun(run.id, result.output);
					await this.invokeHook(() => this.hooks.onRunCompleted?.(run));
					break;

				case "failed":
					// Run-level retry: if we haven't exhausted maxAttempts, re-schedule
					if (run.attempts < run.maxAttempts) {
						const delayMs = computeBackoffMs(
							run.backoff,
							run.attempts, // 1-indexed: first retry = attempt 1
						);
						await this.storage.suspendRun(
							run.id,
							"sleep",
							addDuration(now(), `${Math.ceil(delayMs / 1000)}s`),
						);
						break;
					}
					await this.storage.failRun(run.id, result.error);
					await this.invokeHook(() => this.hooks.onRunFailed?.(run, result.error));
					break;

				case "retryable": {
					// A step failed transiently and has retries remaining.
					// Use the backoff delay computed by the step.
					const delaySeconds = Math.max(1, Math.ceil(result.backoffMs / 1000));
					await this.storage.suspendRun(run.id, "sleep", addDuration(now(), `${delaySeconds}s`));
					break;
				}

				case "suspended":
					await this.storage.suspendRun(run.id, result.reason, result.runAt ?? FAR_FUTURE);
					break;
			}
		} catch (transitionErr) {
			console.error(
				`[workflow] Storage transition failed for run ${run.id} (outcome: ${result.outcome}) — stale-run reclaim will retry:`,
				transitionErr,
			);
		}
	}

	/** Invoke a lifecycle hook, catching and logging any errors. */
	private async invokeHook(fn: () => void | Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (err) {
			console.error("[workflow] Lifecycle hook error:", err);
		}
	}
}

/** Resolve a QueueConfig into a full WorkerLoopConfig with defaults. */
export function resolveWorkerConfig(cfg: Required<QueueConfig>, staleRunTimeoutMs?: number): WorkerLoopConfig {
	return {
		...cfg,
		staleRunTimeoutMs: staleRunTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS,
	};
}
