export const DEFAULT_PROVIDER_ORDER = ["claude", "codex"] as const;

export function normalizeProviderOrder(value: unknown): string[] {
  const known = new Set<string>(DEFAULT_PROVIDER_ORDER);
  const seen = new Set<string>();
  const result: string[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string" || !known.has(item) || seen.has(item)) continue;
      seen.add(item);
      result.push(item);
    }
  }

  for (const provider of DEFAULT_PROVIDER_ORDER) {
    if (!seen.has(provider)) result.push(provider);
  }
  return result;
}

export function sortByProviderOrder<T>(
  items: readonly T[],
  order: unknown,
  providerId: (item: T) => string,
): T[] {
  const rank = new Map(normalizeProviderOrder(order).map((id, index) => [id, index]));
  return [...items].sort((a, b) =>
    (rank.get(providerId(a)) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(providerId(b)) ?? Number.MAX_SAFE_INTEGER));
}
