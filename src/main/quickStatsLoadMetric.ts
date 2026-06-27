export class QuickStatsLoadMetric {
  private firstDurationMs: number | null = null;

  get valueMs(): number | null {
    return this.firstDurationMs;
  }

  record(durationMs: number): boolean {
    if (this.firstDurationMs !== null) return false;
    if (!Number.isFinite(durationMs) || durationMs < 0) return false;
    this.firstDurationMs = durationMs;
    return true;
  }
}
