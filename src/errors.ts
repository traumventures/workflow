export class FatalError extends Error {
    readonly isFatal = true;
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "FatalError";
    }
}

export class RetryableError extends Error {
    readonly isRetryable = true;
    readonly retryAfter?: string;
    constructor(message: string, opts?: { retryAfter?: string }) {
        super(message);
        this.name = "RetryableError";
        this.retryAfter = opts?.retryAfter;
    }
}

/**
 * Thrown when a step exceeds its configured timeout.
 * Treated as a retryable failure (not fatal) — the step will be retried
 * if it has attempts remaining.
 */
export class StepTimeoutError extends Error {
    readonly isTimeout = true;
    constructor(message: string) {
        super(message);
        this.name = "StepTimeoutError";
    }
}

/** Internal — never exposed to app code */
export class SuspendSignal extends Error {
    readonly isSuspend = true;
    constructor(
        public readonly reason: "sleep" | "hook",
        public readonly runAt: string | null,
        public readonly stepKey: string,
    ) {
        super(`Workflow suspended: ${reason}`);
        this.name = "SuspendSignal";
    }
}
