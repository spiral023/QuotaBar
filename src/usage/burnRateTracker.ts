interface SnapshotPoint {
  ts: number;
  pct: number;
}

const RESET_DROP_THRESHOLD = 15;
const MAX_POINTS = 8;
const MIN_POINTS = 3;
const MIN_SPAN_MS = 2 * 60 * 1000;

export class BurnRateTracker {
  private readonly history = new Map<string, SnapshotPoint[]>();

  record(provider: string, windowName: string, pct: number, now: Date): void {
    const key = `${provider}:${windowName}`;
    const arr = this.history.get(key) ?? [];
    const point: SnapshotPoint = { ts: now.getTime(), pct };
    if (arr.length > 0 && pct < arr[arr.length - 1].pct - RESET_DROP_THRESHOLD) {
      this.history.set(key, [point]);
      return;
    }
    arr.push(point);
    if (arr.length > MAX_POINTS) arr.shift();
    this.history.set(key, arr);
  }

  getBurnRate(provider: string, windowName: string): number | null {
    const arr = this.history.get(`${provider}:${windowName}`);
    if (!arr || arr.length < MIN_POINTS) return null;
    const recent = arr.slice(-5);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dtMs = last.ts - first.ts;
    if (dtMs < MIN_SPAN_MS) return null;
    return ((last.pct - first.pct) / dtMs) * 3_600_000;
  }
}
