import type { Backoff } from "./types";

/**
 * Compute the retry delay in milliseconds given the backoff strategy
 * and the attempt number (1-indexed, i.e. first retry = attempt 1).
 *
 * Used by both step-level retries (context.ts) and run-level retries (worker.ts).
 */
export function computeBackoffMs(backoff: Backoff, attempt: number): number {
    const BASE_MS = 1_000;
    switch (backoff) {
        case "none":
            return BASE_MS;
        case "linear":
            return BASE_MS * attempt;
        case "exponential":
            return BASE_MS * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s, …
    }
}
