import { now } from "./duration";
import type { EngineConfig, LifecycleHooks, QueueConfig, RunOptions, WorkflowEngine, WorkflowFn } from "./types";
import { resolveWorkerConfig, WorkerLoop } from "./worker";

const DEFAULT_QUEUE_CONFIG: Required<QueueConfig> = {
	concurrency: 10,
	pollIntervalMs: 1000,
	staleRunTimeoutMs: 300_000,
};

export function createEngine(config: EngineConfig): WorkflowEngine {
	const { storage, defaultQueue = "default", hooks = {} } = config;
	const queues: Record<string, Required<QueueConfig>> = {};

	for (const [name, cfg] of Object.entries(config.queues ?? {})) {
		queues[name] = { ...DEFAULT_QUEUE_CONFIG, ...cfg };
	}
	if (!queues[defaultQueue]) queues[defaultQueue] = { ...DEFAULT_QUEUE_CONFIG };

	// Build registry from workflow definitions
	const registry = new Map<string, WorkflowFn>();
	for (const wfDef of config.workflows) {
		registry.set(wfDef.name, wfDef.handler);
	}

	const engine: WorkflowEngine = {
		async run(name, input, opts) {
			const queue = opts.queue ?? defaultQueue;
			const runAt = opts.runAt ?? now();
			const parentRunId = opts.parentRunId ?? null;
			const maxAttempts = opts.maxAttempts ?? 1;
			const backoff = opts.backoff ?? "exponential";
			if (!queues[queue]) queues[queue] = { ...DEFAULT_QUEUE_CONFIG };

			return storage.createRun(
				{
					name,
					instance: opts.instance,
				},
				{
					status: "pending",
					input: JSON.stringify(input),
					output: null,
					error: null,
					queue,
					parentRunId,
					attempts: 0,
					maxAttempts,
					backoff,
					state: {},
					claimedAt: null,
					runAt,
				},
			);
		},

		async sendEvent(runId, eventName, data) {
			const token = `${runId}:${eventName}`;
			await storage.deliverHookSignal(runId, token, data);
		},

		async cancel(runId) {
			await storage.cancelRun(runId);
			await storage.cancelChildren(runId);
			const run = await storage.getRun(runId);
			if (run) {
				try {
					await hooks.onRunCancelled?.(run);
				} catch {
					// lifecycle hook errors are non-fatal
				}
			}
		},

		async rerun(instanceId) {
			return storage.rerunInstance(instanceId);
		},

		async pendingCount(name) {
			return storage.pendingCount(name);
		},

		async getInstance(instanceId) {
			return storage.getInstance(instanceId);
		},

		async getChildren(runId) {
			return storage.getChildren(runId);
		},

		async getRun(runId) {
			return storage.getRun(runId);
		},

		async getLatestRun(instanceId) {
			return storage.getLatestRun(instanceId);
		},

		async getRuns(instanceId) {
			return storage.getRuns(instanceId);
		},

		async getLogs(runId) {
			if (storage.getLogs) return storage.getLogs(runId);
			return [];
		},

		start() {
			// Build child dispatcher — gives workflow contexts access to
			// engine.run() and engine.rerun() for spawning child workflows.
			const childDispatcher = {
				run: engine.run.bind(engine),
				rerun: engine.rerun.bind(engine),
			};
			const stops: Array<() => Promise<void>> = [];
			for (const [queue, cfg] of Object.entries(queues)) {
				const loopConfig = resolveWorkerConfig(cfg, cfg.staleRunTimeoutMs);
				const loop = new WorkerLoop(queue, loopConfig, storage, registry, hooks, childDispatcher);
				stops.push(loop.start());
			}
			return async () => {
				await Promise.all(stops.map((stop) => stop()));
			};
		},
	};

	return engine;
}
