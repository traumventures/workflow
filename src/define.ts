import type { RunOptions, RunResult, WorkflowDefinition, WorkflowDefinitionConfig, WorkflowEngine } from "./types";

export function defineWorkflow<TInput = unknown, TOutput = unknown>(
	config: WorkflowDefinitionConfig<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
	return {
		name: config.name,
		handler: config.handler,
		run(engine: WorkflowEngine, input: TInput, opts: RunOptions): Promise<RunResult> {
			return engine.run(config.name, input, opts);
		},
	};
}
