import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { SnapshotEvent } from "../main/debugEvents";
import type { CostFactorResult, UsageStatus, UsageWindow } from "../providers/types";
import type { UsagePace } from "../usage/usagePace";
import { withPortableRootLock } from "./rootLock";

const PARTITION_FILE = /^(\d{4}-\d{2})\.jsonl$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const TRANSACTION_FILE = "pending-quota-transaction.json";
const PROVIDERS = new Set(["claude", "codex"]);
const STATUSES = new Set<UsageStatus>(["ok", "not_authenticated", "error", "stale"]);
const WINDOW_NAMES = new Set<UsageWindow["name"]>(["session", "fiveHour", "weekly", "monthly", "credits"]);
const PACE_STAGES = new Set<UsagePace["stage"]>([
  "onTrack", "slightlyAhead", "ahead", "farAhead", "slightlyBehind", "behind", "farBehind",
]);

export interface QuotaSnapshotRange {
  since?: string;
  until?: string;
}

interface TransactionEntry {
  target: string;
  temporary: string;
  sha256: string;
}

interface PendingTransaction {
  schemaVersion: 1;
  transactionId: string;
  entries: TransactionEntry[];
}

const rootQueues = new Map<string, Promise<void>>();

export async function appendQuotaSnapshots(root: string, snapshots: readonly SnapshotEvent[]): Promise<void> {
  const sanitized = snapshots.map(requireQuotaSnapshot);
  if (sanitized.length === 0) return;
  await exclusive(root, async () => {
    await recoverPending(root);
    const incomingByMonth = groupByMonth(sanitized);
    const misplacedByMonth = new Map<string, SnapshotEvent[]>();
    const currentByMonth = new Map<string, SnapshotEvent[]>();
    const originalByMonth = new Map<string, string | undefined>();
    const pending = [...incomingByMonth.keys()];
    const processed = new Set<string>();
    while (pending.length > 0) {
      const month = pending.shift()!;
      if (processed.has(month)) continue;
      processed.add(month);
      const partition = await readPartition(root, month);
      originalByMonth.set(month, partition.contents);
      for (const item of partition.snapshots) {
        const canonicalMonth = monthKey(item.fetchedAt);
        if (canonicalMonth === month) {
          const current = currentByMonth.get(month) ?? [];
          current.push(item);
          currentByMonth.set(month, current);
        } else {
          const misplaced = misplacedByMonth.get(canonicalMonth) ?? [];
          misplaced.push(item);
          misplacedByMonth.set(canonicalMonth, misplaced);
          pending.push(canonicalMonth);
        }
      }
    }
    const writes = new Map<string, string>();
    for (const month of [...processed].sort()) {
      const unique = new Map<string, SnapshotEvent>();
      mergeInto(unique, misplacedByMonth.get(month) ?? []);
      mergeInto(unique, currentByMonth.get(month) ?? []);
      mergeInto(unique, incomingByMonth.get(month) ?? []);
      const contents = serializeSnapshots([...unique.values()]);
      if (contents !== originalByMonth.get(month)) writes.set(partitionPath(root, month), contents);
    }
    await commit(root, writes);
  });
}

export async function readQuotaSnapshots(
  root: string,
  range: QuotaSnapshotRange = {},
): Promise<SnapshotEvent[]> {
  const bounds = parseRange(range);
  return exclusive(root, async () => {
    await recoverPending(root);
    const firstMonth = bounds.since === undefined ? undefined : new Date(bounds.since).toISOString().slice(0, 7);
    const lastMonth = bounds.until === undefined ? undefined : new Date(bounds.until).toISOString().slice(0, 7);
    const snapshots = await readPartitions(root, (month) => (
      (!firstMonth || month >= firstMonth) && (!lastMonth || month <= lastMonth)
    ));
    const unique = new Map<string, SnapshotEvent>();
    for (const item of snapshots.sort(compareSnapshots)) {
      const timestamp = Date.parse(item.fetchedAt);
      if ((bounds.since === undefined || timestamp >= bounds.since)
        && (bounds.until === undefined || timestamp <= bounds.until)) {
        const key = identity(item);
        unique.set(key, unique.has(key) ? mergeSnapshots(unique.get(key)!, item) : item);
      }
    }
    return [...unique.values()].map(cloneSnapshot);
  });
}

async function exclusive<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(root);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = rootQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => withPortableRootLock(resolved, operation));
  const tail = result.then(() => undefined, () => undefined);
  rootQueues.set(key, tail);
  return result.finally(() => {
    if (rootQueues.get(key) === tail) rootQueues.delete(key);
  });
}

async function readPartitions(root: string, include: (month: string) => boolean = () => true): Promise<SnapshotEvent[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(snapshotsDir(root), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ entry, match: PARTITION_FILE.exec(entry.name) }))
    .filter((item): item is { entry: Dirent; match: RegExpExecArray } => (
      item.match !== null && validMonth(item.match[1]) && include(item.match[1])
    ))
    .sort((left, right) => left.match[1].localeCompare(right.match[1]));
  const result: SnapshotEvent[] = [];
  for (const { entry, match } of files) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(snapshotsDir(root), entry.name), "utf8");
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = sanitizeQuotaSnapshot(JSON.parse(line));
        if (item && monthKey(item.fetchedAt) === match[1]) result.push(item);
      } catch {
        // A damaged line must not hide valid records in the same partition.
      }
    }
  }
  return result;
}

async function readPartition(root: string, month: string): Promise<{ contents?: string; snapshots: SnapshotEvent[] }> {
  const filePath = partitionPath(root, month);
  try {
    const info = await fs.lstat(filePath);
    if (!info.isFile()) return { snapshots: [] };
  } catch (error) {
    if (isMissing(error)) return { snapshots: [] };
    throw error;
  }
  const contents = await fs.readFile(filePath, "utf8");
  const snapshots: SnapshotEvent[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = sanitizeQuotaSnapshot(JSON.parse(line));
      if (item) snapshots.push(item);
    } catch {
      // Invalid lines are discarded when an affected partition is rewritten.
    }
  }
  return { contents, snapshots };
}

async function commit(root: string, writes: ReadonlyMap<string, string>): Promise<void> {
  if (writes.size === 0) return;
  const entries: TransactionEntry[] = [];
  const staged: string[] = [];
  const transaction: PendingTransaction = { schemaVersion: 1, transactionId: randomUUID(), entries };
  try {
    for (const [target, contents] of writes) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
      staged.push(temporary);
      entries.push({
        target: path.relative(path.resolve(root), target),
        temporary: path.relative(path.resolve(root), temporary),
        sha256: hash(contents),
      });
    }
    await writeAtomic(transactionPath(root), `${JSON.stringify(transaction)}\n`);
  } catch (error) {
    await cleanup(staged);
    throw error;
  }
  await rollForward(root, transaction);
}

async function recoverPending(root: string): Promise<void> {
  let contents: string;
  try {
    contents = await fs.readFile(transactionPath(root), "utf8");
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  let transaction: PendingTransaction;
  try {
    transaction = parseTransaction(JSON.parse(contents));
    validateTransaction(root, transaction);
  } catch {
    throw new Error("Invalid pending portable quota transaction");
  }
  await rollForward(root, transaction);
}

async function rollForward(root: string, transaction: PendingTransaction): Promise<void> {
  validateTransaction(root, transaction);
  const prepared: Array<{ entry: TransactionEntry; target: string; temporary: string; staged: boolean }> = [];
  for (const entry of transaction.entries) {
    const target = path.resolve(root, entry.target);
    const temporary = path.resolve(root, entry.temporary);
    try {
      const targetInfo = await fs.lstat(target);
      if (!targetInfo.isFile()) throw new Error("Portable quota transaction has a non-file target");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      const staged = await fs.readFile(temporary);
      if (hash(staged) !== entry.sha256) throw new Error("Portable quota transaction checksum mismatch");
      prepared.push({ entry, target, temporary, staged: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
      const committed = await fs.readFile(target).catch(() => undefined);
      if (!committed || hash(committed) !== entry.sha256) {
        throw new Error("Portable quota transaction cannot be recovered safely", { cause: error });
      }
      prepared.push({ entry, target, temporary, staged: false });
    }
  }
  // The root lock excludes QuotaBar writers. An external filesystem change after
  // this preflight can still make a later rename fail, and is reported as such.
  for (const item of prepared) {
    if (item.staged) await renameWithRetry(item.temporary, item.target);
    const committed = await fs.readFile(item.target);
    if (hash(committed) !== item.entry.sha256) throw new Error("Portable quota transaction checksum mismatch");
  }
  try {
    const current = parseTransaction(JSON.parse(await fs.readFile(transactionPath(root), "utf8")));
    if (current.transactionId === transaction.transactionId) await fs.unlink(transactionPath(root));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function writeAtomic(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await renameWithRetry(temporary, target);
  } catch (error) {
    await cleanup([temporary]);
    throw error;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code !== "EPERM" && code !== "EACCES") || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export function sanitizeQuotaSnapshot(value: unknown): SnapshotEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.kind !== "snapshot" || typeof item.provider !== "string" || !PROVIDERS.has(item.provider)
    || typeof item.status !== "string" || !STATUSES.has(item.status as UsageStatus)
    || !isIsoTimestamp(item.fetchedAt) || !Array.isArray(item.windows)) return undefined;
  const windows = item.windows.map(sanitizeWindow);
  if (windows.some((window) => window === undefined)) return undefined;
  const windowNames = new Set(windows.map((window) => window!.name));
  if (windowNames.size !== windows.length) return undefined;
  const result: SnapshotEvent = {
    kind: "snapshot",
    provider: item.provider,
    status: item.status as UsageStatus,
    windows: windows as UsageWindow[],
    fetchedAt: new Date(item.fetchedAt).toISOString(),
  };
  if (item.planType !== undefined) {
    if (!isNonEmptyString(item.planType)) return undefined;
    result.planType = item.planType;
  }
  if (item.cost !== undefined) {
    const cost = sanitizeCost(item.cost);
    if (!cost) return undefined;
    result.cost = cost;
  }
  return result;
}

function sanitizeWindow(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== "string" || !WINDOW_NAMES.has(item.name as UsageWindow["name"])) return undefined;
  const result: UsageWindow = { name: item.name as UsageWindow["name"] };
  for (const field of ["usedPercent", "remainingPercent"] as const) {
    if (item[field] !== undefined) {
      if (!isPercentage(item[field])) return undefined;
      result[field] = item[field];
    }
  }
  if (item.windowSeconds !== undefined) {
    if (!isSafeNonNegativeInteger(item.windowSeconds)) return undefined;
    result.windowSeconds = item.windowSeconds;
  }
  if (item.burnRatePctPerHour !== undefined) {
    if (item.burnRatePctPerHour !== null && !isBoundedNonNegative(item.burnRatePctPerHour)) return undefined;
    result.burnRatePctPerHour = item.burnRatePctPerHour;
  }
  if (item.safetyGapSeconds !== undefined) {
    if (item.safetyGapSeconds !== null && !isBoundedNonNegative(item.safetyGapSeconds)) return undefined;
    result.safetyGapSeconds = item.safetyGapSeconds;
  }
  if (item.resetsAt !== undefined) {
    if (!isIsoTimestamp(item.resetsAt)) return undefined;
    result.resetsAt = new Date(item.resetsAt).toISOString();
  }
  if (item.label !== undefined) {
    if (!isNonEmptyString(item.label)) return undefined;
    result.label = item.label;
  }
  if (item.pace !== undefined) {
    if (item.pace === null) result.pace = null;
    else {
      const pace = sanitizePace(item.pace);
      if (!pace) return undefined;
      result.pace = pace;
    }
  }
  return result;
}

function sanitizePace(value: unknown): UsagePace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.stage !== "string" || !PACE_STAGES.has(item.stage as UsagePace["stage"])
    || !isBoundedDelta(item.deltaPercent) || !isPercentage(item.expectedUsedPercent)
    || !isPercentage(item.actualUsedPercent)
    || (item.etaSeconds !== null && !isBoundedNonNegative(item.etaSeconds))
    || typeof item.willLastToReset !== "boolean") return undefined;
  return {
    stage: item.stage as UsagePace["stage"],
    deltaPercent: item.deltaPercent,
    expectedUsedPercent: item.expectedUsedPercent,
    actualUsedPercent: item.actualUsedPercent,
    etaSeconds: item.etaSeconds as number | null,
    willLastToReset: item.willLastToReset,
  };
}

function sanitizeCost(value: unknown): CostFactorResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!isBoundedNonNegative(item.apiCostUSD) || !isBoundedNonNegative(item.subscriptionCostUSD)
    || (item.factor !== null && !isBoundedNonNegative(item.factor))
    || typeof item.isEstimate !== "boolean" || !isNonEmptyString(item.label)) return undefined;
  const result: CostFactorResult = {
    apiCostUSD: item.apiCostUSD,
    subscriptionCostUSD: item.subscriptionCostUSD,
    factor: item.factor as number | null,
    isEstimate: item.isEstimate,
    label: item.label,
  };
  if (item.windowLabel !== undefined) {
    if (!isNonEmptyString(item.windowLabel)) return undefined;
    result.windowLabel = item.windowLabel;
  }
  if (item.windowDays !== undefined) {
    if (!isSafeNonNegativeInteger(item.windowDays)) return undefined;
    result.windowDays = item.windowDays;
  }
  if (item.calculationMode !== undefined) {
    if (item.calculationMode !== "fixed" && item.calculationMode !== "actual-span") return undefined;
    result.calculationMode = item.calculationMode;
  }
  return result;
}

function requireQuotaSnapshot(value: unknown): SnapshotEvent {
  const sanitized = sanitizeQuotaSnapshot(value);
  if (!sanitized) throw new Error("Invalid portable quota snapshot");
  return sanitized;
}

function parseRange(range: QuotaSnapshotRange): { since?: number; until?: number } {
  const since = range.since === undefined ? undefined : parseBoundary(range.since, false);
  const until = range.until === undefined ? undefined : parseBoundary(range.until, true);
  if (since === null || until === null) throw new Error("Invalid portable quota range");
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("Invalid portable quota range: since is after until");
  }
  return { since, until };
}

function parseBoundary(value: string, endOfDay: boolean): number | null {
  const timestamp = DATE_ONLY.test(value)
    ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : value;
  return isIsoTimestamp(timestamp) ? Date.parse(timestamp) : null;
}

function parseTransaction(value: unknown): PendingTransaction {
  if (!value || typeof value !== "object") throw new Error("invalid transaction");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || !isUuid(item.transactionId) || !Array.isArray(item.entries)) {
    throw new Error("invalid transaction");
  }
  const entries = item.entries.map((entry): TransactionEntry => {
    if (!entry || typeof entry !== "object") throw new Error("invalid entry");
    const fields = entry as Record<string, unknown>;
    if (!isNonEmptyString(fields.target) || !isNonEmptyString(fields.temporary)
      || typeof fields.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(fields.sha256)) {
      throw new Error("invalid entry");
    }
    return { target: fields.target, temporary: fields.temporary, sha256: fields.sha256 };
  });
  return { schemaVersion: 1, transactionId: item.transactionId, entries };
}

function validateTransaction(root: string, transaction: PendingTransaction): void {
  const resolvedRoot = path.resolve(root);
  const seen = new Set<string>();
  for (const entry of transaction.entries) {
    const target = path.resolve(resolvedRoot, entry.target);
    const temporary = path.resolve(resolvedRoot, entry.temporary);
    const match = PARTITION_FILE.exec(path.basename(target));
    if (!match || !validMonth(match[1]) || path.dirname(target) !== snapshotsDir(resolvedRoot)
      || path.dirname(temporary) !== path.dirname(target)
      || !path.basename(temporary).startsWith(`${path.basename(target)}.`)
      || !path.basename(temporary).endsWith(".tmp")
      || entry.target !== path.relative(resolvedRoot, target)
      || entry.temporary !== path.relative(resolvedRoot, temporary)
      || seen.has(target)) throw new Error("invalid transaction path");
    seen.add(target);
  }
}

function identity(item: SnapshotEvent): string {
  return `${item.provider}\0${item.fetchedAt}`;
}

function mergeSnapshots(existing: SnapshotEvent, incoming: SnapshotEvent): SnapshotEvent {
  const windows = existing.windows.map((window) => ({ ...window }));
  const indexByName = new Map(windows.map((window, index) => [window.name, index]));
  for (const window of incoming.windows) {
    const index = indexByName.get(window.name);
    if (index === undefined) {
      indexByName.set(window.name, windows.length);
      windows.push({ ...window });
    } else {
      windows[index] = { ...windows[index], ...window };
    }
  }
  return {
    kind: "snapshot",
    provider: incoming.provider,
    status: incoming.status,
    ...(incoming.planType !== undefined
      ? { planType: incoming.planType }
      : existing.planType !== undefined ? { planType: existing.planType } : {}),
    windows,
    ...(incoming.cost !== undefined
      ? { cost: { ...incoming.cost } }
      : existing.cost !== undefined ? { cost: { ...existing.cost } } : {}),
    fetchedAt: incoming.fetchedAt,
  };
}

function mergeInto(target: Map<string, SnapshotEvent>, snapshots: readonly SnapshotEvent[]): void {
  for (const item of snapshots) {
    const key = identity(item);
    target.set(key, target.has(key) ? mergeSnapshots(target.get(key)!, item) : item);
  }
}

function groupByMonth(snapshots: readonly SnapshotEvent[]): Map<string, SnapshotEvent[]> {
  const grouped = new Map<string, SnapshotEvent[]>();
  for (const item of snapshots) {
    const month = monthKey(item.fetchedAt);
    const current = grouped.get(month) ?? [];
    current.push(item);
    grouped.set(month, current);
  }
  return grouped;
}

function serializeSnapshots(snapshots: readonly SnapshotEvent[]): string {
  if (snapshots.length === 0) return "";
  return `${[...snapshots].sort(compareSnapshots).map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function compareSnapshots(left: SnapshotEvent, right: SnapshotEvent): number {
  return Date.parse(left.fetchedAt) - Date.parse(right.fetchedAt) || left.provider.localeCompare(right.provider);
}

function cloneSnapshot(item: SnapshotEvent): SnapshotEvent {
  return {
    ...item,
    windows: item.windows.map((window) => ({
      ...window,
      ...(window.pace ? { pace: { ...window.pace } } : {}),
    })),
    ...(item.cost ? { cost: { ...item.cost } } : {}),
  };
}

function snapshotsDir(root: string): string {
  return path.join(path.resolve(root), "snapshots");
}

function partitionPath(root: string, month: string): string {
  return path.join(snapshotsDir(root), `${month}.jsonl`);
}

function transactionPath(root: string): string {
  return path.join(path.resolve(root), TRANSACTION_FILE);
}

function validMonth(month: string): boolean {
  const number = Number(month.slice(5));
  return number >= 1 && number <= 12;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  return monthNumber >= 1 && monthNumber <= 12
    && dayNumber >= 1 && dayNumber <= daysInMonth(yearNumber, monthNumber)
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
    && (offsetHour === undefined || Number(offsetHour) <= 23)
    && (offsetMinute === undefined || Number(offsetMinute) <= 59);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function monthKey(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPercentage(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

function isBoundedDelta(value: unknown): value is number {
  return isFiniteNumber(value) && value >= -100 && value <= 100;
}

function isBoundedNonNegative(value: unknown): value is number {
  return isNonNegativeFinite(value) && value <= Number.MAX_SAFE_INTEGER;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function cleanup(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((filePath) => fs.unlink(filePath).catch(() => undefined)));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
