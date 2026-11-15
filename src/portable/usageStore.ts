import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { getPortableUsageDir } from "../config/paths";
import { invalidateDailyRollups, loadDailyRollups, selectDailyRollups, type DailyUsageRollup } from "./dailyRollups";
import {
  PORTABLE_INGEST_JOURNAL_FILE,
  sanitizePortableIngestState,
  serializePortableIngestJournalEntry,
  serializePortableIngestJournalHeader,
  type PortableIngestJournalBase,
} from "./ingestState";
import { withPortableRootLock } from "./rootLock";
import {
  PORTABLE_STORE_VERSION,
  type PortableIngestState,
  type PortableStoreMetadata,
  type PortableUsageEvent
} from "./types";
import {
  canonicalSerialize,
  clonePortableEvent,
  compareText,
  isNonEmptyString,
  monthKey,
  monthKeyOf,
  requirePortableEvent,
  sanitizePortableEvent
} from "./usageEventCodec";
import { buildMetadata, canonicalPath, deduplicateGlobally, deduplicateRepairCandidates, delay, isMissingFile, isRecognizedSiblingTemp, parseRange, parseTransaction, partitionCanonical, PartitionFile, PartitionSnapshot, PendingTransaction, Range, serializeEvents, sha256, snapshotsToMaps, storeRevision, temporaryPath, TransactionEntry } from "./usageStoreFormat";
import { cleanupStaleTemps, readMetadataIdentity, readMetadataPartitions, type StoreFileSystem } from "./usageStoreMaintenance";
export { validatePortableEventForArchive } from "./usageEventCodec";

const PARTITION_FILE = /^(\d{4}-\d{2})\.jsonl$/;
const TRANSACTION_FILE = "pending-store-transaction.json";
interface AppendPlan {
  contents: string;
  events: PortableUsageEvent[];
}

interface PartitionCacheEntry {
  identity: string;
  events: PortableUsageEvent[];
}

/** Changed ingest-state records to append; startWith begins a fresh journal on that snapshot. */
export interface IngestJournalWrite {
  delta: unknown;
  startWith?: PortableIngestJournalBase;
}

interface IngestStateWrite {
  snapshot?: string;
  journal?: { contents: string; flag: "a" | "w" };
}

export interface LegacyDerivedPlan {
  events: readonly PortableUsageEvent[];
  removeIds: readonly string[];
}

export interface LegacyDerivedResult {
  inserted: number;
  updated: number;
  removed: number;
  existing: number;
  revision: string;
}

const rootQueues = new Map<string, Promise<void>>();
const sharedStores = new Map<string, PortableUsageStore>();

/**
 * Returns the process-wide store for a root. Each instance owns a partition
 * cache and a revision memo, so handing out fresh instances per call silently
 * re-reads the whole history; callers that only need a readiness check must
 * share one.
 */
export function getSharedUsageStore(rootDir = getPortableUsageDir()): PortableUsageStore {
  const resolved = path.resolve(rootDir);
  const key = canonicalPath(resolved);
  const existing = sharedStores.get(key);
  if (existing) return existing;
  const store = new PortableUsageStore(resolved);
  sharedStores.set(key, store);
  return store;
}

export class PortableUsageStore {
  private readonly rootDir: string;
  private readonly rootKey: string;
  private readonly partitionCache = new Map<string, PartitionCacheEntry>();
  private metadataIdentity?: string;
  private revisionMemo?: { fingerprint: string; revision: string };
  private metadataPartitions?: Map<string, string>;
  /** Partition path -> size this store last wrote, the precondition for appending. */
  private readonly appendableFiles = new Map<string, bigint>();

  constructor(
    rootDir = getPortableUsageDir(),
    private readonly fileSystem: StoreFileSystem = nodeFs,
  ) {
    this.rootDir = path.resolve(rootDir);
    this.rootKey = canonicalPath(this.rootDir);
  }

  getIngestStatePath(): string {
    return this.ingestStatePath();
  }

  recoverPending(): Promise<void> {
    return this.exclusive(() => this.prepareStore());
  }

  getRevision(): Promise<string> {
    return this.exclusive(async () => {
      await this.prepareStore();
      return this.currentRevision();
    });
  }

  /**
   * Hashing every event costs seconds on a large store, and callers poll this
   * to answer "did anything change?". Partition identities answer that first;
   * only a changed fingerprint re-serializes. The digest stays byte-identical
   * to storeRevision(), so persisted revisions remain comparable.
   */
  private async currentRevision(): Promise<string> {
    const stamped: Array<PartitionFile & { identity: string }> = [];
    for (const file of await this.listPartitions()) {
      stamped.push({ ...file, identity: await this.partitionIdentity(file.filePath) });
    }
    stamped.sort((left, right) => compareText(left.month, right.month));
    const fingerprint = stamped.map(({ month, identity }) => `${month}:${identity}`).join("|");
    if (this.revisionMemo?.fingerprint === fingerprint) return this.revisionMemo.revision;

    const digest = createHash("sha256");
    digest.update(`[${PORTABLE_STORE_VERSION},[`);
    let first = true;
    for (const file of stamped) {
      const events = (await this.readValidEvents(file.filePath))
        .filter((item) => monthKeyOf(item.occurredAt) === file.month);
      if (!first) digest.update(",");
      first = false;
      digest.update(partitionCanonical(file.month, events));
    }
    digest.update("]]");
    const revision = digest.digest("hex");
    this.revisionMemo = { fingerprint, revision };
    return revision;
  }

  private async partitionIdentity(filePath: string): Promise<string> {
    try {
      const info = await this.fileSystem.lstat(filePath, { bigint: true });
      return info.isFile() ? `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.dev}:${info.ino}` : "non-file";
    } catch (error) {
      if (isMissingFile(error)) return "missing";
      throw error;
    }
  }

  commitIfRevision(
    expectedRevision: string,
    commit: () => Promise<void>,
  ): Promise<{ status: "applied" | "stale"; revision: string }> {
    return this.exclusive(async () => {
      await this.prepareStore();
      const revision = await this.currentRevision();
      if (revision !== expectedRevision) return { status: "stale", revision };
      await commit();
      return { status: "applied", revision };
    });
  }

  read(range: Range = {}): Promise<PortableUsageEvent[]> {
    return this.exclusive(async () => {
      await this.prepareStore();
      return this.readUnlocked(range);
    });
  }

  /** Compact additive metrics; partial boundary groups fall back to canonical events. */
  readDaily(timeZone: string, range: Range = {}): Promise<DailyUsageRollup[]> {
    return this.exclusive(async () => {
      await this.prepareStore();
      const bounds = parseRange(range);
      const files = await this.listPartitions();
      const identities = await Promise.all(files.map(async (file) => {
        const stat = await this.fileSystem.lstat(file.filePath, { bigint: true });
        return { month: file.month, identity: [stat.size, stat.mtimeNs, stat.ctimeNs, stat.dev, stat.ino].join(":") };
      }));
      const rows = await loadDailyRollups(this.rootDir, timeZone, identities, async () => {
        const raw = (await this.scanPartitions({ acceptMisplaced: false })).flatMap(({ events }) => events);
        const events = deduplicateGlobally(raw);
        return { events, independentPartitions: events.length === raw.length };
      }, (month) => {
        const start = new Date(`${month}-01T00:00:00.000Z`);
        const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
        return this.readUnlocked({ since: start.toISOString(), until: new Date(end.getTime() - 1).toISOString() });
      });
      return selectDailyRollups(rows, timeZone, bounds, (range) => this.readUnlocked(range));
    });
  }

  private async readUnlocked(range: Range): Promise<PortableUsageEvent[]> {
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
  }

  async upsert(events: readonly PortableUsageEvent[]): Promise<{ inserted: number; existing: number }> {
    return this.exclusive(async () => {
      await this.prepareStore();
      const sanitized = events.map((item) => requirePortableEvent(item));
      const snapshots = await this.scanPartitions({ acceptMisplaced: false });
      const storedByMonth = snapshotsToMaps(snapshots);
      const knownIds = new Set(snapshots.flatMap(({ events: stored }) => stored.map(({ id }) => id)));
      await this.invalidateDuplicateRollups(snapshots, knownIds.size);
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
        const month = monthKeyOf(item.occurredAt);
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

  async reconcile(events: readonly PortableUsageEvent[]): Promise<{ inserted: number; updated: number; existing: number }> {
    return this.exclusive(() => this.reconcileUnlocked(events));
  }

  reconcileLegacyDerived(
    builder: (currentEvents: readonly PortableUsageEvent[]) => LegacyDerivedPlan,
  ): Promise<LegacyDerivedResult> {
    return this.exclusive(async () => {
      await this.prepareStore();
      const snapshots = await this.scanPartitions({ acceptMisplaced: false });
      const storedByMonth = snapshotsToMaps(snapshots);
      const current = deduplicateGlobally(snapshots.flatMap(({ events }) => events));
      const storedById = new Map(current.map((event) => [event.id, event]));
      await this.invalidateDuplicateRollups(snapshots, storedById.size);
      const plan = builder(current.map(clonePortableEvent));
      if (!plan || !Array.isArray(plan.events) || !Array.isArray(plan.removeIds)) {
        throw new Error("Invalid derived reconciliation plan");
      }

      const incomingById = new Map<string, PortableUsageEvent>();
      for (const candidate of plan.events) {
        const event = requirePortableEvent(candidate);
        if (event.source !== "legacy-reconciliation") {
          throw new Error("Derived reconciliation accepts only legacy events");
        }
        const stored = storedById.get(event.id);
        if (stored && stored.source !== "legacy-reconciliation") {
          throw new Error("Derived reconciliation cannot replace provider events");
        }
        incomingById.set(event.id, event);
      }
      const removeIds = new Set<string>();
      for (const id of plan.removeIds) {
        if (!isNonEmptyString(id)) throw new Error("Invalid derived reconciliation removal ID");
        if (incomingById.has(id)) throw new Error("Derived reconciliation cannot write and remove the same event");
        const stored = storedById.get(id);
        if (!stored) throw new Error("Derived reconciliation cannot remove unknown events");
        if (stored && stored.source !== "legacy-reconciliation") {
          throw new Error("Derived reconciliation cannot remove provider events");
        }
        removeIds.add(id);
      }

      const affected = new Set<string>();
      let removed = 0;
      for (const id of removeIds) {
        if (!storedById.has(id)) continue;
        removed += 1;
        for (const [month, partition] of storedByMonth) {
          if (partition.delete(id)) affected.add(month);
        }
      }

      let inserted = 0;
      let updated = 0;
      let existing = 0;
      for (const event of incomingById.values()) {
        const stored = storedById.get(event.id);
        if (!stored) {
          inserted += 1;
        } else if (canonicalSerialize(stored) === canonicalSerialize(event)) {
          existing += 1;
          continue;
        } else {
          updated += 1;
          for (const [month, partition] of storedByMonth) {
            if (partition.delete(event.id)) affected.add(month);
          }
        }
        const month = monthKeyOf(event.occurredAt);
        const partition = storedByMonth.get(month) ?? new Map<string, PortableUsageEvent>();
        partition.set(event.id, event);
        storedByMonth.set(month, partition);
        affected.add(month);
      }

      if (affected.size > 0) {
        const writes = new Map<string, string>();
        const removals: string[] = [];
        for (const month of [...affected].sort()) {
          const partition = storedByMonth.get(month);
          if (!partition || partition.size === 0) {
            removals.push(this.partitionPath(month));
            storedByMonth.delete(month);
          } else {
            writes.set(this.partitionPath(month), serializeEvents(partition.values()));
          }
        }
        writes.set(this.metadataPath(), `${JSON.stringify(buildMetadata(storedByMonth), null, 2)}\n`);
        await this.commitTransaction(writes, removals);
        return { inserted, updated, removed, existing, revision: storeRevision(storedByMonth) };
      }
      // Nothing was written, so the memoized revision of the untouched partitions
      // is exact and spares re-hashing every event on each reconciliation.
      return { inserted, updated, removed, existing, revision: await this.currentRevision() };
    });
  }

  async reconcileWithIngestState(
    events: readonly PortableUsageEvent[],
    state: unknown,
  ): Promise<{ inserted: number; updated: number; existing: number }> {
    let sanitized: PortableIngestState;
    try {
      sanitized = sanitizePortableIngestState(state);
    } catch {
      throw new Error("Invalid portable ingest state");
    }
    return this.exclusive(() => this.reconcileUnlocked(events, {
      snapshot: `${JSON.stringify(sanitized, null, 2)}\n`,
    }));
  }

  /** Like reconcileWithIngestState, but records only the changed sources in the ingest journal. */
  async reconcileWithIngestJournal(
    events: readonly PortableUsageEvent[],
    write: IngestJournalWrite,
  ): Promise<{ inserted: number; updated: number; existing: number }> {
    let contents: string;
    try {
      const entry = serializePortableIngestJournalEntry(write.delta);
      contents = write.startWith ? `${serializePortableIngestJournalHeader(write.startWith)}${entry}` : entry;
    } catch {
      throw new Error("Invalid portable ingest state");
    }
    return this.exclusive(() => this.reconcileUnlocked(events, {
      journal: { contents, flag: write.startWith ? "w" : "a" },
    }));
  }

  private async reconcileUnlocked(
    events: readonly PortableUsageEvent[],
    ingestState: IngestStateWrite = {},
  ): Promise<{ inserted: number; updated: number; existing: number }> {
    await this.prepareStore();
    // Readers may emit the same immutable source ID more than once; the last source occurrence is authoritative.
    const incomingById = new Map<string, PortableUsageEvent>();
    for (const item of events) {
      const sanitized = requirePortableEvent(item);
      incomingById.set(sanitized.id, sanitized);
    }

    // Metadata/stat identities plus the in-memory partition cache avoid unchanged file reads. Reconciliation still
    // builds a transient ID map; a persistent archive-wide ID index is intentionally deferred to avoid a new sidecar.
    const snapshots = await this.scanPartitions({ acceptMisplaced: false });
    const storedByMonth = snapshotsToMaps(snapshots);
    const storedById = new Map<string, PortableUsageEvent>();
    for (const snapshot of snapshots) {
      for (const item of snapshot.events) {
        if (!storedById.has(item.id)) storedById.set(item.id, item);
      }
    }

    await this.invalidateDuplicateRollups(snapshots, storedById.size);
    const affected = new Set<string>();
    // Ingestion is overwhelmingly append-only: new events for the current month.
    // Recording which months saw nothing but insertions lets those partitions be
    // appended to instead of rewritten in full.
    const insertedByMonth = new Map<string, PortableUsageEvent[]>();
    let mutatedStored = false;
    let inserted = 0;
    let updated = 0;
    let existing = 0;
    for (const item of incomingById.values()) {
      const stored = storedById.get(item.id);
      if (!stored) {
        inserted += 1;
      } else if (canonicalSerialize(stored) === canonicalSerialize(item)) {
        existing += 1;
        continue;
      } else {
        updated += 1;
        mutatedStored = true;
        for (const [month, partition] of storedByMonth) {
          if (partition.delete(item.id)) affected.add(month);
        }
      }

      const month = monthKeyOf(item.occurredAt);
      const partition = storedByMonth.get(month) ?? new Map<string, PortableUsageEvent>();
      partition.set(item.id, item);
      storedByMonth.set(month, partition);
      affected.add(month);
      if (!stored) {
        const pending = insertedByMonth.get(month) ?? [];
        pending.push(item);
        insertedByMonth.set(month, pending);
      }
    }

    const writes = new Map<string, string>();
    const appends = new Map<string, AppendPlan>();
    const removals: string[] = [];
    for (const month of [...affected].sort()) {
      const partition = storedByMonth.get(month);
      if (!partition || partition.size === 0) {
        removals.push(this.partitionPath(month));
        storedByMonth.delete(month);
        continue;
      }
      const partitionPath = this.partitionPath(month);
      const additions = mutatedStored ? undefined : insertedByMonth.get(month);
      const priorSize = additions ? partition.size - additions.length : 0;
      if (additions && additions.length > 0 && await this.canAppendTo(partitionPath, priorSize)) {
        appends.set(partitionPath, { contents: serializeEvents(additions), events: additions });
      } else {
        writes.set(partitionPath, serializeEvents(partition.values()));
      }
    }
    writes.set(this.metadataPath(), `${JSON.stringify(buildMetadata(storedByMonth), null, 2)}\n`);
    if (ingestState.snapshot !== undefined) {
      writes.set(this.ingestStatePath(), ingestState.snapshot);
      // The new snapshot already contains everything the journal recorded. The
      // journal goes first: losing it only rolls the state back to the older
      // snapshot, while surviving next to a new one could replay stale records.
      await this.removeIngestJournal();
    }
    // Appends run first on purpose. A crash between the two leaves the events on
    // disk while ingest-state still lists the source as unread, so the next pass
    // re-derives the same immutable IDs and settles as "existing" — no loss, no
    // duplicates. The reverse order could drop events permanently. The journal
    // line comes last for the same reason.
    await this.commitAppends(appends);
    await this.commitTransaction(writes, removals);
    if (ingestState.journal) {
      await this.fileSystem.writeFile(this.ingestJournalPath(), ingestState.journal.contents, {
        encoding: "utf8",
        flag: ingestState.journal.flag,
      });
    }
    return { inserted, updated, existing };
  }

  rebuildMetadata(): Promise<PortableStoreMetadata> {
    return this.exclusive(async () => {
      await this.prepareStore();
      const snapshots = await this.scanPartitions({ acceptMisplaced: true });
      const repaired = deduplicateRepairCandidates(snapshots.flatMap(({ month, events }) =>
        events.map((event) => ({
          event,
          canonical: monthKeyOf(event.occurredAt) === month,
        }))));
      const repairedByMonth = new Map<string, Map<string, PortableUsageEvent>>();
      for (const item of repaired) {
        const month = monthKeyOf(item.occurredAt);
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
    const result = previous.catch(() => undefined).then(() => withPortableRootLock(this.rootDir, operation));
    const tail = result.then(() => undefined, () => undefined);
    rootQueues.set(this.rootKey, tail);
    return result.finally(() => {
      if (rootQueues.get(this.rootKey) === tail) rootQueues.delete(this.rootKey);
    });
  }

  /** A partial rebuild cannot retain globally deduplicated rows from ambiguous partitions. */
  private async invalidateDuplicateRollups(snapshots: readonly PartitionSnapshot[], uniqueCount: number): Promise<void> {
    if (snapshots.reduce((sum, snapshot) => sum + snapshot.events.length, 0) !== uniqueCount) {
      await invalidateDailyRollups(this.rootDir);
    }
  }

  private async prepareStore(): Promise<void> {
    await this.recoverPendingTransaction();
    await this.cleanupStaleTemps();
  }

  private async scanPartitions(options: {
    include?: (month: string) => boolean;
    acceptMisplaced: boolean;
  }): Promise<PartitionSnapshot[]> {
    const metadataIdentity = await this.readMetadataIdentity();
    if (this.metadataIdentity !== undefined && this.metadataIdentity !== metadataIdentity) {
      await this.dropPartitionsChangedExternally();
    }
    this.metadataIdentity = metadataIdentity;
    const files = (await this.listPartitions()).filter(({ month }) => options.include?.(month) ?? true);
    const snapshots: PartitionSnapshot[] = [];
    for (const file of files) {
      const events = await this.readValidEvents(file.filePath);
      snapshots.push({
        ...file,
        events: options.acceptMisplaced
          ? events
          : events.filter((item) => monthKeyOf(item.occurredAt) === file.month),
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

  /**
   * Appending is only safe when the file on disk is exactly what this store last
   * wrote. A size that no longer matches means someone else wrote it, or a
   * previous append was cut short by a crash and left a partial line — either
   * way the partition is rewritten in full, which repairs it.
   *
   * Ordering inside the file is deliberately not a concern: readers sort events
   * on load and the revision digest is computed from the sorted set, so an
   * appended line does not have to be in chronological position.
   */
  private async canAppendTo(filePath: string, expectedEventCount: number): Promise<boolean> {
    if (expectedEventCount === 0) return false;
    const known = this.appendableFiles.get(canonicalPath(filePath));
    if (known === undefined) return false;
    try {
      const info = await this.fileSystem.lstat(filePath, { bigint: true });
      return info.isFile() && info.size === known;
    } catch {
      return false;
    }
  }

  /**
   * Writes only the new lines. Partition rewrites dominated this store's disk
   * traffic: a single new event rewrote the whole month, tens of megabytes at a
   * time, many times per minute during active use.
   */
  private async commitAppends(appends: ReadonlyMap<string, AppendPlan>): Promise<void> {
    if (appends.size > 0) await invalidateDailyRollups(this.rootDir, [...appends.keys()]);
    for (const [filePath, plan] of appends) {
      const key = canonicalPath(filePath);
      const cached = this.partitionCache.get(key);
      await this.fileSystem.writeFile(filePath, plan.contents, { encoding: "utf8", flag: "a" });
      this.revisionMemo = undefined;
      let identity: string | undefined;
      let size: bigint | undefined;
      try {
        const info = await this.fileSystem.lstat(filePath, { bigint: true });
        if (info.isFile()) {
          identity = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.dev}:${info.ino}`;
          size = info.size;
        }
      } catch {
        // Losing the post-append identity only costs a re-read next time.
      }
      // The appended events are already sanitized, so the cache can be extended
      // instead of dropped — otherwise every append would force a full re-parse.
      if (identity !== undefined && cached !== undefined) {
        this.partitionCache.set(key, {
          identity,
          events: [...cached.events, ...plan.events.map(clonePortableEvent)],
        });
      } else {
        this.partitionCache.delete(key);
      }
      if (size !== undefined) this.appendableFiles.set(key, size);
      else this.appendableFiles.delete(key);
    }
  }

  private async readValidEvents(filePath: string): Promise<PortableUsageEvent[]> {
    let identity: string;
    try {
      const info = await this.fileSystem.lstat(filePath, { bigint: true });
      if (!info.isFile()) return [];
      identity = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.dev}:${info.ino}`;
    } catch (error) {
      if (isMissingFile(error)) {
        this.partitionCache.delete(canonicalPath(filePath));
        return [];
      }
      throw error;
    }
    const cacheKey = canonicalPath(filePath);
    const cached = this.partitionCache.get(cacheKey);
    if (cached?.identity === identity) return cached.events.map(clonePortableEvent);
    let contents: string;
    try {
      contents = await this.fileSystem.readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        this.partitionCache.delete(cacheKey);
        return [];
      }
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
    this.partitionCache.set(cacheKey, { identity, events: events.map(clonePortableEvent) });
    return events;
  }

  private async commitTransaction(writes: ReadonlyMap<string, string>, removals: readonly string[] = []): Promise<void> {
    const entries: TransactionEntry[] = [];
    const stagedTemporaryPaths: string[] = [];
    const transactionId = randomUUID();
    const transaction: PendingTransaction = {
      schemaVersion: 1,
      transactionId,
      entries,
      remove: removals.map((filePath) => this.relativePath(filePath)),
    };
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
      await this.writeStandaloneAtomic(this.transactionPath(), `${JSON.stringify(transaction, null, 2)}\n`);
    } catch (error) {
      await this.cleanupIgnoringErrors(stagedTemporaryPaths);
      throw error;
    }
    await this.rollForward(transaction);
    this.metadataIdentity = await this.readMetadataIdentity();
    this.metadataPartitions = await this.readMetadataPartitions();
  }

  /**
   * Another process (or an import) rewrote the store. Metadata carries a
   * per-month event count and last timestamp, so only the months it reports as
   * changed need dropping instead of the whole cache. An unreadable or
   * unparsable metadata file falls back to clearing everything.
   */
  private async dropPartitionsChangedExternally(): Promise<void> {
    this.revisionMemo = undefined;
    const current = await this.readMetadataPartitions();
    const previous = this.metadataPartitions;
    if (!current || !previous) {
      this.partitionCache.clear();
      this.metadataPartitions = current;
      return;
    }
    for (const month of new Set([...current.keys(), ...previous.keys()])) {
      if (current.get(month) !== previous.get(month)) {
        this.partitionCache.delete(canonicalPath(this.partitionPath(month)));
      }
    }
    this.metadataPartitions = current;
  }

  /** Month -> compact signature of that partition, or undefined if unreadable. */
  private readMetadataPartitions() { return readMetadataPartitions(this.fileSystem, this.metadataPath()); }

  private readMetadataIdentity() { return readMetadataIdentity(this.fileSystem, this.metadataPath()); }

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
      this.validateTransactionPaths(transaction);
    } catch {
      throw new Error("Invalid pending portable store transaction");
    }
    await this.rollForward(transaction);
  }

  private async rollForward(transaction: PendingTransaction): Promise<void> {
    if (transaction.entries.some(({ target }) => canonicalPath(path.dirname(this.resolveRelative(target))) === canonicalPath(this.eventsDir()))
      || transaction.remove.length > 0) {
      await invalidateDailyRollups(this.rootDir, [...transaction.entries.map((entry) => entry.target), ...transaction.remove]);
    }
    // Every write path funnels through here (commit and startup recovery), so
    // this is the one place that can drop cached state deterministically.
    // File identities alone cannot: NTFS timestamp granularity lets two writes
    // of equal size share size/mtime/ctime, which would strand a stale cache.
    this.revisionMemo = undefined;
    for (const target of transaction.entries.map((entry) => entry.target).concat(transaction.remove)) {
      const key = canonicalPath(this.resolveRelative(target));
      this.partitionCache.delete(key);
      this.appendableFiles.delete(key);
    }
    for (const entry of transaction.entries) {
      const target = this.resolveRelative(entry.target);
      const temporary = this.resolveRelative(entry.temporary);
      // The staged file is verified before it is renamed into place, and a
      // missing staged file means the rename already happened, so the target is
      // verified instead. Re-reading the target after a successful rename would
      // hash the same bytes a second time — on a large partition that is tens of
      // megabytes of pointless reads per commit.
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
    }
    for (const removal of transaction.remove) await this.removeObsoletePartition(removal);
    await this.removeMarkerIfOwned(transaction.transactionId);
    // Record what was just written so the next insert-only reconcile can append
    // to these files instead of rewriting them.
    for (const entry of transaction.entries) {
      const target = this.resolveRelative(entry.target);
      try {
        const info = await this.fileSystem.lstat(target, { bigint: true });
        if (info.isFile()) this.appendableFiles.set(canonicalPath(target), info.size);
      } catch {
        // Without a recorded size the file simply stays on the rewrite path.
      }
    }
  }

  private validateTransactionPaths(transaction: PendingTransaction): void {
    const targets = new Set<string>();
    const temporaries = new Set<string>();
    for (const entry of transaction.entries) {
      const target = this.resolveRelative(entry.target);
      const temporary = this.resolveRelative(entry.temporary);
      if (entry.target !== path.relative(this.rootDir, target)
        || entry.temporary !== path.relative(this.rootDir, temporary)
        || !this.isAllowedTransactionTarget(target)
        || canonicalPath(path.dirname(temporary)) !== canonicalPath(path.dirname(target))
        || !isRecognizedSiblingTemp(target, temporary)) throw new Error("invalid transaction path");
      const targetKey = canonicalPath(target);
      const temporaryKey = canonicalPath(temporary);
      if (targets.has(targetKey) || temporaries.has(temporaryKey)) throw new Error("duplicate transaction path");
      targets.add(targetKey);
      temporaries.add(temporaryKey);
    }
    const removalKeys = new Set<string>();
    for (const removal of transaction.remove) {
      const resolved = this.resolveRemoval(removal);
      const removalKey = canonicalPath(resolved);
      if (removal !== path.relative(this.rootDir, resolved)
        || targets.has(removalKey) || removalKeys.has(removalKey)) throw new Error("overlapping transaction paths");
      removalKeys.add(removalKey);
    }
  }

  private isAllowedTransactionTarget(target: string): boolean {
    if (canonicalPath(target) === canonicalPath(this.metadataPath())) return true;
    if (canonicalPath(target) === canonicalPath(this.ingestStatePath())) return true;
    const match = PARTITION_FILE.exec(path.basename(target));
    return Boolean(match && isValidMonth(match[1])
      && canonicalPath(path.dirname(target)) === canonicalPath(this.eventsDir()));
  }

  private async removeMarkerIfOwned(transactionId: string): Promise<void> {
    try {
      const marker = parseTransaction(JSON.parse(await this.fileSystem.readFile(this.transactionPath(), "utf8")));
      if (marker.transactionId === transactionId) await this.fileSystem.unlink(this.transactionPath());
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof SyntaxError)) return;
    }
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

  private cleanupStaleTemps() { return cleanupStaleTemps(this.fileSystem, this.rootDir); }

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

  private ingestStatePath(): string {
    return path.join(this.rootDir, "ingest-state.json");
  }

  private ingestJournalPath(): string {
    return path.join(this.rootDir, PORTABLE_INGEST_JOURNAL_FILE);
  }

  private async removeIngestJournal(): Promise<void> {
    try {
      await this.fileSystem.unlink(this.ingestJournalPath());
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  private transactionPath(): string {
    return path.join(this.rootDir, TRANSACTION_FILE);
  }
}

function isValidMonth(month: string): boolean {
  const monthNumber = Number(month.slice(5));
  return monthNumber >= 1 && monthNumber <= 12;
}
