import type { UsageSnapshot } from "../providers/types";
import type { BarData, TrayIconState } from "./renderTrayIcon";

export function buildIconState(snapshots: UsageSnapshot[]): TrayIconState {
  const byProvider = new Map(snapshots.map((s) => [s.provider, s]));

  function barFor(providerId: string): BarData | undefined {
    const snap = byProvider.get(providerId);
    if (!snap || (snap.status !== "ok" && snap.status !== "stale")) return undefined;
    const win = snap.windows.find((w) => w.name === "fiveHour");
    return {
      usedPercent: win?.usedPercent,
      isStale: snap.status === "stale",
    };
  }

  const geminiSnap = byProvider.get("gemini");
  const gemini =
    geminiSnap && (geminiSnap.status === "ok" || geminiSnap.status === "stale")
      ? { usedPercent: undefined as undefined, isStale: geminiSnap.status === "stale" }
      : undefined;

  return {
    codex: barFor("codex"),
    claude: barFor("claude"),
    gemini,
    hasError: snapshots.some((s) => s.status === "stale"),
  };
}
