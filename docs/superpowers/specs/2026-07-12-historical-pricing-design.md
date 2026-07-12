# Historical Pricing Design

## Goal

Keep QuotaBar's calculated token costs stable after a provider price change while
preserving provider-supplied Claude costs and existing backfill reports exactly.

## Findings

- Claude source entries can contain `costUSD`; `auto` mode already uses that
  value instead of calculating it.
- Codex source entries contain token deltas but no provider cost.
- Live reports, the live cost factor, and backfill generation currently resolve
  missing costs through the current LiteLLM map.
- Backfill reports read persisted day summaries and must never recalculate their
  stored costs.
- LiteLLM publishes the current price table. Its repository history records
  changes to that file but does not establish provider-effective timestamps, so
  it is not a source of historical price validity.

## Design

### Historical pricing store

Persist a compact model-level history in QuotaBar's application cache. It does
not copy LiteLLM's approximately 1.5 MB complete catalogue for every refresh.
Each stored epoch contains:

- canonical model lookup key;
- normalized `ModelPricing` value;
- `fetchedAt` timestamp;
- LiteLLM source URL; and
- SHA-256 checksum of the canonical pricing payload.

Only models actually resolved by QuotaBar are stored. A new epoch is appended
only when its checksum differs from the most recent epoch for that model.

### Resolution semantics

`HistoricalPricingResolver` is the sole API used by calculated Claude and Codex
cost paths. Given a model and an event timestamp, it returns the most recent
stored epoch whose `fetchedAt` is less than or equal to the event timestamp.
Thus an event after a locally observed price change uses the new price, while
an older event keeps the preceding price. The comparison uses the complete ISO
timestamp, not a day bucket.

LiteLLM does not publish a provider-effective timestamp. QuotaBar therefore
does not backdate a locally observed price. The first timestamp at which a new
price is eligible is the successful LiteLLM fetch time.

If no eligible local epoch exists (including users migrating from earlier
QuotaBar versions), QuotaBar uses the current LiteLLM price. Per the accepted
product decision, this fallback is not shown as an estimate in the UI.

### Precedence and compatibility

1. A Claude entry's existing `costUSD` wins in `auto` and `display` mode.
2. Existing backfill summaries remain read-only and retain their stored values.
3. Only missing source costs are resolved through the historical resolver.
4. `calculate` mode deliberately recalculates all Claude token entries, using
   the resolver's historical epochs when available.

No migration alters logs, backfill files, or reports. The history cache starts
empty and fills when models are resolved after upgrading.

### Integration

- `LiteLLMFetcher` remains responsible for downloading and normalizing external
  data.
- `HistoricalPricingResolver` owns persisted epochs and timestamp selection.
- The Codex calculator, report service, subscription factor, and backfill
  writer receive a resolver instead of independently using current pricing.
- The resolver exposes the same `getModelPricing(model, timestamp)` shape
  needed by callers, keeping the calculation modules small and testable.

## Tests

Tests will prove two event timestamps straddling a stored price change receive
different prices, a later cheaper epoch does not change earlier results,
Claude `costUSD` wins in `auto`, legacy no-epoch data uses current pricing,
and existing backfill report values remain stable. The complete unit suite and
TypeScript build are required before handoff.

## Known limit

The cache records when QuotaBar observed a price, not a provider-certified
effective time. Events predating the first observed epoch use the current-price
compatibility fallback selected for this product.
