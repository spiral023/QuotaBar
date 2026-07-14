import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getHistoricalPricingPath } from "../config/paths";
import type { ModelPricing } from "./cost-calculator";
import { LITELLM_PRICING_SOURCE } from "./litellm-fetcher";

export interface ModelPricingLookup {
  getModelPricing(modelName: string): Promise<ModelPricing | null>;
}

export interface VersionedModelPricing {
  pricing: ModelPricing;
  pricingVersion: string;
}

export interface HistoricalPricingResolverOptions {
  historyPath?: string;
  now?: () => Date;
  storage?: HistoricalPricingStorage;
}

export interface HistoricalPricingStorage {
  read(historyPath: string): Promise<string | undefined>;
  write(historyPath: string, content: string): Promise<void>;
}

interface PricingEpoch {
  fetchedAt: string;
  checksum: string;
  pricing: ModelPricing;
}

interface PricingHistory {
  version: 1;
  source: string;
  epochs: Record<string, PricingEpoch[]>;
}

const PRICING_FIELDS = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_creation_input_token_cost",
  "cache_read_input_token_cost",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost_above_200k_tokens",
] as const;

const historyQueues = new Map<string, Promise<void>>();
const historyCache = new Map<string, PricingHistory>();

const fileStorage: HistoricalPricingStorage = {
  async read(historyPath) {
    try {
      return await fs.readFile(historyPath, "utf8");
    } catch {
      return undefined;
    }
  },
  async write(historyPath, content) {
    try {
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      const tempPath = `${historyPath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tempPath, content, "utf8");
      await fs.rename(tempPath, historyPath);
    } catch {
      // The current pricing still provides the legacy fallback when local persistence is unavailable.
    }
  },
};

export class HistoricalPricingResolver implements ModelPricingLookup {
  private readonly historyPath: string;
  private readonly now: () => Date;
  private readonly storage: HistoricalPricingStorage;

  constructor(
    private readonly pricingLookup: ModelPricingLookup,
    options: HistoricalPricingResolverOptions = {},
  ) {
    this.historyPath = options.historyPath ?? getHistoricalPricingPath();
    this.now = options.now ?? (() => new Date());
    this.storage = options.storage ?? fileStorage;
  }

  async getModelPricing(modelName: string, eventTimestamp?: Date | string | number): Promise<ModelPricing | null> {
    const [resolved] = await this.getModelPricingBatch(modelName, [eventTimestamp]);
    return resolved?.pricing ?? null;
  }

  async getModelPricingBatch(
    modelName: string,
    eventTimestamps: readonly (Date | string | number | undefined)[],
  ): Promise<(VersionedModelPricing | null)[]> {
    const currentPricing = await this.pricingLookup.getModelPricing(modelName);
    if (!currentPricing) return eventTimestamps.map(() => null);

    return withHistoryLock(this.historyPath, async () => {
      let history = historyCache.get(this.historyPath);
      if (!history) {
        history = await loadHistory(this.historyPath, this.storage);
        historyCache.set(this.historyPath, history);
      }
      const pricing = normalizePricing(currentPricing);
      const checksum = pricingChecksum(pricing);
      const epochs = history.epochs[modelName] ?? [];
      const latest = epochs.at(-1);

      if (!latest || latest.checksum !== checksum) {
        epochs.push({ fetchedAt: this.now().toISOString(), checksum, pricing });
        history.epochs[modelName] = epochs;
        await this.storage.write(this.historyPath, JSON.stringify(history, null, 2));
      }

      return eventTimestamps.map((eventTimestamp) => {
        const eventTime = toTimestamp(eventTimestamp);
        const historical = eventTime == null ? undefined : latestEpochAtOrBefore(epochs, eventTime);
        const resolvedPricing = normalizePricing(historical?.pricing ?? currentPricing);
        return {
          pricing: resolvedPricing,
          pricingVersion: `litellm:${pricingChecksum(resolvedPricing)}`,
        };
      });
    });
  }
}

/** Clears path-keyed resolver state between isolated tests that remove or corrupt history files. */
export function resetHistoricalPricingResolverCacheForTests(): void {
  historyCache.clear();
  historyQueues.clear();
}

function normalizePricing(pricing: ModelPricing): ModelPricing {
  const normalized: ModelPricing = {};
  for (const field of PRICING_FIELDS) {
    const value = pricing[field];
    if (typeof value === "number" && Number.isFinite(value)) normalized[field] = value;
  }
  const fast = pricing.provider_specific_entry?.fast;
  if (typeof fast === "number" && Number.isFinite(fast)) {
    normalized.provider_specific_entry = { fast };
  }
  return normalized;
}

function pricingChecksum(pricing: ModelPricing): string {
  return createHash("sha256").update(JSON.stringify(pricing)).digest("hex");
}

async function loadHistory(historyPath: string, storage: HistoricalPricingStorage): Promise<PricingHistory> {
  try {
    const content = await storage.read(historyPath);
    if (!content) return emptyHistory();
    const parsed: unknown = JSON.parse(content);
    if (!isPricingHistory(parsed)) return emptyHistory();
    return normalizeHistory(parsed);
  } catch {
    return emptyHistory();
  }
}

function isPricingHistory(value: unknown): value is PricingHistory {
  if (!value || typeof value !== "object") return false;
  const history = value as Partial<PricingHistory>;
  return history.version === 1
    && history.source === LITELLM_PRICING_SOURCE
    && !!history.epochs
    && typeof history.epochs === "object"
    && Object.values(history.epochs).every((epochs) => Array.isArray(epochs) && epochs.every(isPricingEpoch));
}

function isPricingEpoch(value: unknown): value is PricingEpoch {
  if (!value || typeof value !== "object") return false;
  const epoch = value as Partial<PricingEpoch>;
  return typeof epoch.fetchedAt === "string"
    && toTimestamp(epoch.fetchedAt) != null
    && typeof epoch.checksum === "string"
    && /^[a-f0-9]{64}$/.test(epoch.checksum)
    && !!epoch.pricing
    && typeof epoch.pricing === "object"
    && epoch.checksum === pricingChecksum(normalizePricing(epoch.pricing));
}

function normalizeHistory(history: PricingHistory): PricingHistory {
  const epochs = Object.create(null) as Record<string, PricingEpoch[]>;
  for (const [modelName, modelEpochs] of Object.entries(history.epochs)) {
    epochs[modelName] = modelEpochs.map((epoch) => ({
      fetchedAt: epoch.fetchedAt,
      checksum: epoch.checksum,
      pricing: normalizePricing(epoch.pricing),
    }));
  }
  return { version: 1, source: LITELLM_PRICING_SOURCE, epochs };
}

function emptyHistory(): PricingHistory {
  return { version: 1, source: LITELLM_PRICING_SOURCE, epochs: Object.create(null) as Record<string, PricingEpoch[]> };
}

function toTimestamp(value: Date | string | number | undefined): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : timestamp;
  }
  return null;
}

function latestEpochAtOrBefore(epochs: PricingEpoch[], eventTimestamp: number): PricingEpoch | undefined {
  return epochs.reduce<PricingEpoch | undefined>((latest, epoch) => {
    const epochTimestamp = toTimestamp(epoch.fetchedAt);
    if (epochTimestamp == null || epochTimestamp > eventTimestamp) return latest;
    if (!latest || epochTimestamp > toTimestamp(latest.fetchedAt)!) return epoch;
    return latest;
  }, undefined);
}

async function withHistoryLock<T>(historyPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = historyQueues.get(historyPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  historyQueues.set(historyPath, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (historyQueues.get(historyPath) === current) historyQueues.delete(historyPath);
  }
}
