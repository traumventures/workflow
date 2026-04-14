import { buildContext } from "./context";
import type { StateCache, StepCompletion } from "./context";
import { FatalError, SuspendSignal } from "./errors";
import type { ChildDispatcher, WorkflowFn, WorkflowRun, WorkflowStorage } from "./types";

export type ExecuteResult = (
	| { outcome: "completed"; output: unknown }
	| { outcome: "failed"; error: string } // permanent failure — FatalError or uncaught error
	| { outcome: "retryable"; error: string; backoffMs: number } // transient step failure — reschedule the run
	| { outcome: "suspended"; reason: "sleep" | "hook"; runAt: string | null }
) & { completedSteps: StepCompletion[] };

export async function executeWorkflow(
	run: WorkflowRun,
	workflowName: string,
	fn: WorkflowFn,
	storage: WorkflowStorage,
	childDispatcher?: ChildDispatcher,
): Promise<ExecuteResult> {
	// Load the single state blob — contains all buckets (step, memo, sleep, event, etc.)
	const stateData = await storage.getState(run.id);
	const stateCache: StateCache = { data: stateData };

	const { wf, consumeRetryInfo, completedSteps } = buildContext(
		run.id,
		run.instanceId,
		workflowName,
		storage,
		stateCache,
		childDispatcher,
	);
	const input = JSON.parse(run.input);

	try {
		const output = await fn(input, wf);
		return { outcome: "completed", output, completedSteps };
	} catch (err) {
		if (err instanceof SuspendSignal) {
			return {
				outcome: "suspended",
				reason: err.reason,
				runAt: err.runAt,
				completedSteps,
			};
		}
		const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
		// FatalError (including step exhaustion promoted to FatalError) → permanent failure
		// Any other error rethrown from a step → retryable (worker will reschedule the run)
		if (err instanceof FatalError) {
			return { outcome: "failed", error: msg, completedSteps };
		}

		// Read retry info from this context instance (concurrency-safe).
		// If no retry info exists, the error happened outside a retryable step
		// (for example in workflow top-level code) and should fail fast instead
		// of retrying forever.
		const retryInfo = consumeRetryInfo();
		if (!retryInfo) {
			return { outcome: "failed", error: msg, completedSteps };
		}
		const backoffMs = retryInfo?.backoffMs ?? 1_000;

		return { outcome: "retryable", error: msg, backoffMs, completedSteps };
	}
}
