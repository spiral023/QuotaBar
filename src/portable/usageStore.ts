import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { getPortableUsageDir } from "../config/paths";
import {
  PORTABLE_STORE_VERSION,
  type PortableStoreMetadata,
  type PortableUsageEvent,
} from "./types";

const PARTITION_FILE = /^(\d{4}-\d{2})\.jsonl$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const TRANSACTION_FILE = "pending-store-transaction.json";
const TEMP_FILE = /^(?:store-metadata\.json|pending-store-transaction\.json|\d{4}-\d{2}\.jsonl)\.\d+\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
const STALE_TEMP_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "reasoningOutputTokens",
] as const;
const COST_FIELDS = [
  "costUSD",
  "inputCostUSD",
  "outputCostUSD",
  "cacheCreationCostUSD",
  "cacheReadCostUSD",
] as const;

type Range = { since?: string; until?: string };
type StoreFileSystem = Pick<
  typeof nodeFs,
  "lstat" | "mkdir" | "readFile" | "readdir" | "rename" | "unlink" | "writeFile"
>;

interface PartitionFile {
  month: string;
  filePath: string;
}

interface PartitionSnapshot extends PartitionFile {
  events: PortableUsageEvent[];
}

interface TransactionEntry {
  target: string;
  temporary: string;
  sha256: string;
}

interface PendingTransaction {
  schemaVersion: 1;
  entries: TransactionEntry[];
  remove: string[];
}

interface SanitizedResult {
  event?: PortableUsageEvent;
  problem?: string;
}

const rootQueues = new Map<string, Promise<void>>();

export class PortableUsageStore {
  private readonly rootDir: string;
  private readonly rootKey: string;

  constructor(
    rootDir = getPortableUsageDir(),
    private readonly fileSystem: StoreFileSystem = nodeFs,
  ) {
    this.rootDir = path.resolve(rootDir);
    this.rootKey = canonicalPath(this.rootDir);
  }

  read(range: Range = {}): Promise<PortableUsageEvent[]> {
    return this.exclusive(async () => {
      await this.prepareStore();
      const bounds = parseRange(range);
      const firstMonth = bounds.since === undefined ? undefined : monthKey(new Date(bounds.since));
      const lastMonth = bounds.until === undefined ? undefined : monthKey(new Date(bounds.until));
      const snapshots = await this.scanPartitions({
        include: (month) => (!firstMonth || month >= firstMonth) && (!lastMonth || month <= lastMonth),
        acceptMisplaced: false,
      });
      const unique = deduplicateGlobally(snapshots.flatMap(({ events }) => events));
      return unique.filter((item) => {
        const occurredAt = Date.parse(item.occurredAt);
        return (bounds.since === undefined || occurredAt >= bounds.since)
          && (bounds.until === undefined || occurredAt <= bounds.until);
      });
    });
  }

  async upsert(events: readonly PortableUsageEvent[]): Promise<{ inserted: number; existing: number }> {
    return this.exclusive(async () => {
      await this.prepareStore();
      const sanitized = events.map((item) => requirePortableEvent(item));
      const snapshots = await this.scanPartitions({ acceptMisplaced: false });
      const storedByMonth = snapshotsToMaps(snapshots);
      const knownIds = new Set(snapshots.flatMap(({ events: stored }) => stored.map(({ id }) => id)));
      const incoming: PortableUsageEvent[] = [];
      let existing = 0;
      for (const item of sanitized) {
        if (knownIds.has(item.id)) {
          existing += 1;
        } else {
          knownIds.add(item.id);
          incoming.push(item);
        }
      }

      const affected = new Set<string>();
      for (const item of incoming) {
        const month = monthKey(new Date(item.occurredAt));
        const partition = storedByMonth.get(month) ?? new Map<string, PortableUsageEvent>();
        partition.set(item.id, item);
        storedByMonth.set(month, partition);
        affected.add(month);
      }

      const writes = new Map<string, string>();
      for (const month of [...affected].sort()) {
        writes.set(this.partitionPath(month), serializeEvents(storedByMonth.get(month)?.values() ?? []));
      }
      const metadata = buildMetadata(storedByMonth);
      writes.set(this.metadataPath(), `${JSON.stringify(metadata, null, 2)}\n`);
      await this.commitTransaction(writes);
      return { inserted: incoming.length, existing };
    });
  }

  rebuildMetadata(): Promise<PortableStoreMetadata> {
    return this.exclusive(async () => {
      await this.prepareStore();
      const snapshots = await this.scanPartitions({ acceptMisplaced: true });
      const repaired = deduplicateGlobally(snapshots.flatMap(({ events }) => events));
      const repairedByMonth = new Map<string, Map<string, PortableUsageEvent>>();
      for (const item of repaired) {
        const month = monthKey(new Date(item.occurredAt));
        const partition = repairedByMonth.get(month) ?? new Map<string, PortableUsageEvent>();
        partition.set(item.id, item);
        repairedByMonth.set(month, partition);
      }

      const writes = new Map<string, string>();
      for (const [month, partition] of [...repairedByMonth].sort(([a], [b]) => a.localeCompare(b))) {
        writes.set(this.partitionPath(month), serializeEvents(partition.values()));
      }
      const metadata = buildMetadata(repairedByMonth);
      writes.set(this.metadataPath(), `${JSON.stringify(metadata, null, 2)}\n`);
      const canonicalTargets = new Set([...repairedByMonth.keys()].map((month) => canonicalPath(this.partitionPath(month))));
      const removals = snapshots
        .map(({ filePath }) => filePath)
        .filter((filePath) => !canonicalTargets.has(canonicalPath(filePath)));
      await this.commitTransaction(writes, removals);
      await this.cleanupStaleTemps();
      return metadata;
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    // Electron's single-instance lock covers normal cross-process use; this queue coordinates in-process stores.
    const previous = rootQueues.get(this.rootKey) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    rootQueues.set(this.rootKey, tail);
    return result.finally(() => {
      if (rootQueues.get(this.rootKey) === tail) rootQueues.delete(this.rootKey);
    });
  }

  private async prepareStore(): Promise<void> {
    await this.recoverPendingTransaction();
    await this.cleanupStaleTemps();
  }

  private async scanPartitions(options: {
    include?: (month: string) => boolean;
    acceptMisplaced: boolean;
  }): Promise<PartitionSnapshot[]> {
    const files = (await this.listPartitions()).filter(({ month }) => options.include?.(month) ?? true);
    const snapshots: PartitionSnapshot[] = [];
    for (const file of files) {
      const events = await this.readValidEvents(file.filePath);
      snapshots.push({
        ...file,
        events: options.acceptMisplaced
          ? events
          : events.filter((item) => monthKey(new Date(item.occurredAt)) === file.month),
      });
    }
    return snapshots;
  }

  private async listPartitions(): Promise<PartitionFile[]> {
    const eventsDir = this.eventsDir();
    let entries: Dirent[];
    try {
      entries = await this.fileSystem.readdir(eventsDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    return entries
      .filter((entry) => typeof entry !== "string" && entry.isFile())
      .map((entry) => ({ entry, match: PARTITION_FILE.exec(entry.name) }))
      .filter((item): item is { entry: Dirent; match: RegExpExecArray } => item.match !== null)
      .map(({ entry, match }) => ({ month: match[1], filePath: path.join(eventsDir, entry.name) }))
      .filter(({ month }) => isValidMonth(month))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  private async readValidEvents(filePath: string): Promise<PortableUsageEvent[]> {
    let contents: string;
    try {
      contents = await this.fileSystem.readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const events: PortableUsageEvent[] = [];
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const result = sanitizePortableEvent(JSON.parse(line));
        if (result.event) events.push(result.event);
      } catch {
        // A damaged line must not hide valid records in the same partition.
      }
    }
    return events;
  }

  private async commitTransaction(writes: ReadonlyMap<string, string>, removals: readonly string[] = []): Promise<void> {
    const entries: TransactionEntry[] = [];
    const stagedTemporaryPaths: string[] = [];
    try {
      for (const [target, contents] of writes) {
        await this.fileSystem.mkdir(path.dirname(target), { recursive: true });
        const temporary = temporaryPath(target);
        stagedTemporaryPaths.push(temporary);
        await this.fileSystem.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
        entries.push({
          target: this.relativePath(target),
          temporary: this.relativePath(temporary),
          sha256: sha256(contents),
        });
      }
      const transaction: PendingTransaction = {
        schemaVersion: 1,
        entries,
        remove: removals.map((filePath) => this.relativePath(filePath)),
      };
      await this.writeStandaloneAtomic(this.transactionPath(), `${JSON.stringify(transaction, null, 2)}\n`);
    } catch (error) {
      await this.cleanupIgnoringErrors(stagedTemporaryPaths);
      throw error;
    }

    const transaction: PendingTransaction = {
      schemaVersion: 1,
      entries,
      remove: removals.map((filePath) => this.relativePath(filePath)),
    };
    await this.rollForward(transaction);
  }

  private async recoverPendingTransaction(): Promise<void> {
    const marker = this.transactionPath();
    let contents: string;
    try {
      const markerInfo = await this.fileSystem.lstat(marker);
      if (!markerInfo.isFile()) throw new Error("Invalid pending portable store transaction");
      contents = await this.fileSystem.readFile(marker, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    let transaction: PendingTransaction;
    try {
      transaction = parseTransaction(JSON.parse(contents));
      for (const entry of transaction.entries) {
        this.resolveRelative(entry.target);
        this.resolveRelative(entry.temporary);
      }
      for (const removal of transaction.remove) this.resolveRemoval(removal);
    } catch {
      throw new Error("Invalid pending portable store transaction");
    }
    await this.rollForward(transaction);
  }

  private async rollForward(transaction: PendingTransaction): Promise<void> {
    for (const entry of transaction.entries) {
      const target = this.resolveRelative(entry.target);
      const temporary = this.resolveRelative(entry.temporary);
      if (await this.isRegularFile(temporary)) {
        const staged = await this.fileSystem.readFile(temporary);
        if (sha256(staged) !== entry.sha256) throw new Error("Portable store transaction checksum mismatch");
        await this.renameWithRetry(temporary, target);
      } else {
        const committed = await this.readFileIfRegular(target);
        if (!committed || sha256(committed) !== entry.sha256) {
          throw new Error("Portable store transaction cannot be recovered safely");
        }
      }
      const committed = await this.readFileIfRegular(target);
      if (!committed || sha256(committed) !== entry.sha256) {
        throw new Error("Portable store transaction checksum mismatch");
      }
    }
    for (const removal of transaction.remove) await this.removeObsoletePartition(removal);
    await this.fileSystem.unlink(this.transactionPath());
  }

  private async writeStandaloneAtomic(target: string, contents: string): Promise<void> {
    await this.fileSystem.mkdir(path.dirname(target), { recursive: true });
    const temporary = temporaryPath(target);
    try {
      await this.fileSystem.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
      await this.renameWithRetry(temporary, target);
    } catch (error) {
      await this.cleanupIgnoringErrors([temporary]);
      throw error;
    }
  }

  private async renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.fileSystem.rename(from, to);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if ((code !== "EPERM" && code !== "EACCES") || attempt >= 2) throw error;
        await delay(10 * (attempt + 1));
      }
    }
  }

  private async cleanupStaleTemps(): Promise<void> {
    const cutoff = Date.now() - STALE_TEMP_AGE_MS;
    for (const directory of [this.rootDir, this.eventsDir()]) {
      let entries: Dirent[];
      try {
        entries = await this.fileSystem.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        if (typeof entry === "string" || !entry.isFile() || !TEMP_FILE.test(entry.name)) continue;
        const filePath = path.join(directory, entry.name);
        const info = await this.fileSystem.lstat(filePath);
        if (info.isFile() && info.mtimeMs < cutoff) await this.fileSystem.unlink(filePath);
      }
    }
  }

  private async removeObsoletePartition(relative: string): Promise<void> {
    const filePath = this.resolveRemoval(relative);
    try {
      const info = await this.fileSystem.lstat(filePath);
      if (!info.isFile()) throw new Error("Refusing to remove a non-file portable partition");
      await this.fileSystem.unlink(filePath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  private async cleanupIgnoringErrors(paths: readonly string[]): Promise<void> {
    for (const filePath of paths) {
      try {
        await this.fileSystem.unlink(filePath);
      } catch {
        // Preserve the primary staging failure; recognized stale temps are cleaned later.
      }
    }
  }

  private async isRegularFile(filePath: string): Promise<boolean> {
    try {
      return (await this.fileSystem.lstat(filePath)).isFile();
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
  }

  private async readFileIfRegular(filePath: string): Promise<Buffer | undefined> {
    if (!(await this.isRegularFile(filePath))) return undefined;
    return this.fileSystem.readFile(filePath);
  }

  private resolveRemoval(relative: string): string {
    const resolved = this.resolveRelative(relative);
    const match = PARTITION_FILE.exec(path.basename(resolved));
    if (!match || !isValidMonth(match[1]) || canonicalPath(path.dirname(resolved)) !== canonicalPath(this.eventsDir())) {
      throw new Error("Invalid portable partition removal");
    }
    return resolved;
  }

  private resolveRelative(relative: string): string {
    if (!relative || path.isAbsolute(relative)) throw new Error("Invalid portable transaction path");
    const resolved = path.resolve(this.rootDir, relative);
    if (canonicalPath(resolved) === this.rootKey || !canonicalPath(resolved).startsWith(`${this.rootKey}${path.sep}`)) {
      throw new Error("Invalid portable transaction path");
    }
    return resolved;
  }

  private relativePath(filePath: string): string {
    const relative = path.relative(this.rootDir, filePath);
    this.resolveRelative(relative);
    return relative;
  }

  private eventsDir(): string {
    return path.join(this.rootDir, "events");
  }

  private partitionPath(month: string): string {
    return path.join(this.eventsDir(), `${month}.jsonl`);
  }

  private metadataPath(): string {
    return path.join(this.rootDir, "store-metadata.json");
  }

  private transactionPath(): string {
    return path.join(this.rootDir, TRANSACTION_FILE);
  }
}

function sanitizePortableEvent(value: unknown): SanitizedResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: "expected an object" };
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== PORTABLE_STORE_VERSION) return { problem: "schemaVersion must be 1" };
  if (item.provider !== "claude" && item.provider !== "codex") return { problem: "provider is not supported" };
  if (!isNonEmptyString(item.id)) return { problem: "id must be a non-empty string" };
  if (!isIsoTimestamp(item.occurredAt)) return { problem: "occurredAt must be an ISO timestamp" };
  if (!isNonEmptyString(item.model)) return { problem: "model must be a non-empty string" };
  if (!isNonEmptyString(item.sessionKey)) return { problem: "sessionKey must be a non-empty string" };
  if (item.source !== "claude-log" && item.source !== "codex-log" && item.source !== "legacy-reconciliation") {
    return { problem: "source is not supported" };
  }
  if (typeof item.synthetic !== "boolean") return { problem: "synthetic must be a boolean" };
  for (const field of TOKEN_FIELDS) {
    if (!isNonNegativeFiniteNumber(item[field])) return { problem: `${field} must be finite and non-negative` };
  }
  for (const field of COST_FIELDS) {
    if (item[field] !== undefined && !isNonNegativeFiniteNumber(item[field])) {
      return { problem: `${field} must be finite and non-negative` };
    }
  }
  if (item.projectName !== undefined && typeof item.projectName !== "string") {
    return { problem: "projectName must be a string" };
  }
  if (item.pricingVersion !== undefined && !isNonEmptyString(item.pricingVersion)) {
    return { problem: "pricingVersion must be a non-empty string" };
  }

  const event: PortableUsageEvent = {
    schemaVersion: PORTABLE_STORE_VERSION,
    id: item.id,
    provider: item.provider,
    occurredAt: item.occurredAt,
    model: item.model,
    sessionKey: item.sessionKey,
    source: item.source,
    synthetic: item.synthetic,
    inputTokens: item.inputTokens as number,
    outputTokens: item.outputTokens as number,
    cacheCreationTokens: item.cacheCreationTokens as number,
    cacheReadTokens: item.cacheReadTokens as number,
    reasoningOutputTokens: item.reasoningOutputTokens as number,
  };
  if (item.projectName !== undefined) event.projectName = item.projectName;
  for (const field of COST_FIELDS) {
    if (item[field] !== undefined) event[field] = item[field] as number;
  }
  if (item.pricingVersion !== undefined) event.pricingVersion = item.pricingVersion;
  return { event };
}

function requirePortableEvent(value: unknown): PortableUsageEvent {
  const result = sanitizePortableEvent(value);
  if (!result.event) throw new Error(`Invalid portable usage event: ${result.problem}`);
  return result.event;
}

function snapshotsToMaps(snapshots: readonly PartitionSnapshot[]): Map<string, Map<string, PortableUsageEvent>> {
  const result = new Map<string, Map<string, PortableUsageEvent>>();
  for (const snapshot of snapshots) {
    const partition = new Map<string, PortableUsageEvent>();
    for (const item of [...snapshot.events].sort(compareCanonicalEvents)) {
      if (!partition.has(item.id)) partition.set(item.id, item);
    }
    result.set(snapshot.month, partition);
  }
  return result;
}

function deduplicateGlobally(events: readonly PortableUsageEvent[]): PortableUsageEvent[] {
  const unique = new Map<string, PortableUsageEvent>();
  for (const item of [...events].sort(compareCanonicalEvents)) {
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return [...unique.values()].sort(compareCanonicalEvents);
}

function buildMetadata(partitions: ReadonlyMap<string, ReadonlyMap<string, PortableUsageEvent>>): PortableStoreMetadata {
  const metadata: PortableStoreMetadata = {
    schemaVersion: PORTABLE_STORE_VERSION,
    partitions: {},
    updatedAt: new Date().toISOString(),
  };
  for (const [month, partition] of [...partitions].sort(([a], [b]) => a.localeCompare(b))) {
    const events = [...partition.values()].sort(compareCanonicalEvents);
    if (events.length === 0) continue;
    metadata.partitions[month] = {
      eventCount: events.length,
      firstAt: events[0].occurredAt,
      lastAt: events[events.length - 1].occurredAt,
    };
  }
  return metadata;
}

function serializeEvents(events: Iterable<PortableUsageEvent>): string {
  const lines = [...events].sort(compareCanonicalEvents).map((item) => canonicalSerialize(item));
  return `${lines.join("\n")}\n`;
}

function canonicalSerialize(event: PortableUsageEvent): string {
  return JSON.stringify(event);
}

function compareCanonicalEvents(left: PortableUsageEvent, right: PortableUsageEvent): number {
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
    || compareText(left.id, right.id)
    || compareText(canonicalSerialize(left), canonicalSerialize(right));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseTransaction(value: unknown): PendingTransaction {
  if (!value || typeof value !== "object") throw new Error("invalid transaction");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || !Array.isArray(item.entries) || !Array.isArray(item.remove)) {
    throw new Error("invalid transaction");
  }
  const entries = item.entries.map((entry): TransactionEntry => {
    if (!entry || typeof entry !== "object") throw new Error("invalid transaction entry");
    const fields = entry as Record<string, unknown>;
    if (!isNonEmptyString(fields.target) || !isNonEmptyString(fields.temporary)
      || typeof fields.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(fields.sha256)) {
      throw new Error("invalid transaction entry");
    }
    return { target: fields.target, temporary: fields.temporary, sha256: fields.sha256 };
  });
  if (!item.remove.every((entry): entry is string => isNonEmptyString(entry))) {
    throw new Error("invalid transaction removal");
  }
  return { schemaVersion: 1, entries, remove: [...item.remove] };
}

function parseRange(range: Range): { since?: number; until?: number } {
  const since = range.since === undefined ? undefined : parseBoundary(range.since, false);
  const until = range.until === undefined ? undefined : parseBoundary(range.until, true);
  if (since === null || until === null) throw new Error("Invalid portable usage range");
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("Invalid portable usage range: since is after until");
  }
  return { since, until };
}

function parseBoundary(value: string, endOfDay: boolean): number | null {
  if (DATE_ONLY.test(value)) {
    const timestamp = `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`;
    return isIsoTimestamp(timestamp) ? Date.parse(timestamp) : null;
  }
  return isIsoTimestamp(value) ? Date.parse(value) : null;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth(year, month)
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidMonth(month: string): boolean {
  const monthNumber = Number(month.slice(5));
  return monthNumber >= 1 && monthNumber <= 12;
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function temporaryPath(target: string): string {
  return `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
