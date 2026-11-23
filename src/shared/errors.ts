export class NotAuthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

export class ProviderFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderFetchError";
  }
}

export class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`rate limited, retry after ${Math.round(retryAfterMs / 1000)}s`);
    this.name = "RateLimitError";
  }
}

const SAFE_ERRNO_CODE = /^E[A-Z0-9]{2,15}$/;

/**
 * Finds the first errno-style code (`EPERM`, `EBUSY`, ...) on an error or its
 * `cause` chain. Only the code is returned - never the message, which for
 * filesystem errors embeds host paths.
 */
export function errnoCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && SAFE_ERRNO_CODE.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Builds a path-free boundary error that keeps the errno code for field
 * diagnosis: `"<message> (EPERM)"`, with the code also on `error.code`.
 * The original error is deliberately not attached as `cause`.
 */
export function boundaryError(message: string, error: unknown): Error & { code?: string } {
  const code = errnoCode(error);
  return code ? Object.assign(new Error(`${message} (${code})`), { code }) : new Error(message);
}

/** True when `error` is the boundary error `message`, with or without an errno suffix. */
export function isBoundaryError(error: unknown, message: string): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === message || (error.message.startsWith(`${message} (`) && error.message.endsWith(")"));
}

/** `" (EPERM)"` when the error carries an errno code, otherwise an empty string. */
export function errnoSuffix(error: unknown): string {
  const code = errnoCode(error);
  return code ? ` (${code})` : "";
}

export function toErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = typeof (cause as Error & { code?: unknown }).code === "string"
      ? `${(cause as Error & { code: string }).code}: `
      : "";
    return `${error.message} (${code}${cause.message})`;
  }

  return error.message;
}
