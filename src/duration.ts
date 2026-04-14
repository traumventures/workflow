const UNIT_MS: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
};

export function parseDuration(duration: string): number {
    const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(duration.trim());
    if (!match) throw new Error(`Invalid duration string: "${duration}"`);
    return parseInt(match[1], 10) * UNIT_MS[match[2]];
}

export function addDuration(base: string, duration: string): string {
    return new Date(new Date(base).getTime() + parseDuration(duration)).toISOString();
}

export function now(): string {
    return new Date().toISOString();
}
