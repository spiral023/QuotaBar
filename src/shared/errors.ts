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
