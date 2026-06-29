export const MIN_RETRY_MS = 5_000;
export const MAX_RETRY_MS = 30 * 60_000;
export const JITTER_MAX_MS = 3_000;

export function computeBackoffMs(
  serverRetryAfterMs: number,
  consecutive: number,
  random: () => number = Math.random,
): number {
  const retryAfter = Number.isFinite(serverRetryAfterMs) && serverRetryAfterMs > 0
    ? serverRetryAfterMs
    : MIN_RETRY_MS;
  const base = Math.max(retryAfter, MIN_RETRY_MS);
  const exponent = Math.max(0, consecutive - 1);
  const scaled = Math.min(MAX_RETRY_MS, base * 2 ** exponent);
  return scaled + Math.floor(random() * JITTER_MAX_MS);
}
