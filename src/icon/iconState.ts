import type { UsageSnapshot } from "../providers/types";
import { sortByProviderOrder } from "../providers/providerOrder";
import type { BarData, TrayIconState } from "./renderTrayIcon";

export function buildIconState(snapshots: UsageSnapshot[], providerOrder?: unknown): TrayIconState {
  function barFor(snap: UsageSnapshot): BarData | undefined {
    if (!snap || (snap.status !== "ok" && snap.status !== "stale")) return undefined;
    const fiveHour = snap.windows.find((w) => w.name === "fiveHour");
    const weekly = snap.windows.find((w) => w.name === "weekly");
    const win = fiveHour ?? weekly;
    return {
      provider: snap.provider,
      usedPercent: win?.usedPercent,
      isStale: snap.status === "stale",
    };
  }

  return {
    bars: sortByProviderOrder(snapshots, providerOrder, (snapshot) => snapshot.provider)
      .map(barFor)
      .filter((bar): bar is BarData => bar !== undefined),
    hasError: snapshots.some((s) => s.status === "stale" || s.status === "error"),
  };
}
