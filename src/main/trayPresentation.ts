import type { UsageSnapshot } from "../providers/types";
import { sortByProviderOrder } from "../providers/providerOrder";

export function buildTooltip(snapshots: UsageSnapshot[], providerOrder?: unknown): string {
  const lines = ["QuotaBar"];
  const ordered = sortByProviderOrder(snapshots, providerOrder, (snapshot) => snapshot.provider);
  for (const snapshot of ordered) {
    const usage = snapshot.windows.find((window) => typeof window.usedPercent === "number")?.usedPercent;
    if (typeof usage === "number") {
      lines.push(`${capitalize(snapshot.provider)}: ${Math.round(usage)}%`);
    }
  }
  return lines.join("\n");
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
