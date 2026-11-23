import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";

/**
 * Shared building blocks for crash-safe file replacement.
 *
 * Every writer stages its contents in a sibling temporary file created with
 * O_EXCL (`wx`), so an existing path - including a planted symlink - is never
 * followed, and then renames it over the target. On Windows that rename fails
 * transiently with EPERM/EBUSY/EACCES while a virus scanner, the search indexer
 * or a concurrent reader holds the target open, so the rename is retried with
 * exponential backoff instead of giving up after a few milliseconds.
 */

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export const RENAME_RETRY_ATTEMPTS = 6;
const RENAME_RETRY_BASE_MS = 16;
const RENAME_RETRY_MAX_DELAY_MS = 500;

export interface RenameRetryOptions {
  /** Injectable for tests and for callers with their own filesystem facade. */
  rename?: (from: string, to: string) => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  /** Total attempts including the first one. */
  attempts?: number;
}

export async function renameWithRetry(from: string, to: string, options: RenameRetryOptions = {}): Promise<void> {
  const rename = options.rename ?? nodeFs.rename;
  await retryTransient(() => rename(from, to), options);
}

/** True for the Windows sharing-violation codes that clear up once another handle closes. */
export function isTransientFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return Boolean(code && RETRYABLE_RENAME_CODES.has(code));
}

/** Runs `operation`, retrying transient sharing violations with the rename backoff. */
export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: Pick<RenameRetryOptions, "wait" | "attempts"> = {},
): Promise<T> {
  const wait = options.wait ?? delay;
  const attempts = Math.max(1, options.attempts ?? RENAME_RETRY_ATTEMPTS);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientFileError(error) || attempt >= attempts) throw error;
      await wait(renameRetryDelay(attempt));
    }
  }
}

/** Backoff before retry `attempt` (1-based): 16, 32, 64, 128, 256 ms, capped at 500 ms. */
export function renameRetryDelay(attempt: number): number {
  return Math.min(RENAME_RETRY_MAX_DELAY_MS, RENAME_RETRY_BASE_MS * 2 ** (attempt - 1));
}

/**
 * Default sibling temporary name: `<target>.<pid>.<epoch ms>.<uuid>.tmp`.
 * The portable store's TEMP_FILE cleanup pattern recognizes exactly this shape.
 */
export function siblingTemporaryPath(target: string): string {
  return `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}

export type AtomicFileSystem = Pick<typeof nodeFs, "writeFile" | "rename" | "unlink" | "mkdir">;

export interface WriteFileAtomicOptions {
  /**
   * Flush the temporary file to disk before the rename. Use for small files
   * whose loss after a power cut would hurt (settings, credentials, pending
   * import metadata); large derived files skip it for speed.
   */
  fsync?: boolean;
  /** Permission bits for the new file (POSIX only; ignored on Windows). */
  mode?: number;
  /** Create the parent directory first. */
  createParent?: boolean;
  /** Override the temporary name when a caller-specific cleanup pattern must match it. */
  temporaryPath?: string;
  fileSystem?: AtomicFileSystem;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function writeFileAtomic(
  target: string,
  contents: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const fileSystem = options.fileSystem ?? nodeFs;
  if (options.createParent) await fileSystem.mkdir(path.dirname(target), { recursive: true });
  const temporary = options.temporaryPath ?? siblingTemporaryPath(target);
  try {
    await fileSystem.writeFile(temporary, contents, {
      ...(typeof contents === "string" ? { encoding: "utf8" as const } : {}),
      flag: "wx",
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.fsync ? { flush: true } : {}),
    });
    await renameWithRetry(temporary, target, {
      rename: (from, to) => fileSystem.rename(from, to),
      ...(options.wait ? { wait: options.wait } : {}),
    });
  } catch (error) {
    try {
      await fileSystem.unlink(temporary);
    } catch {
      // Preserve the primary failure; a missing or locked temp is cleaned up later.
    }
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
