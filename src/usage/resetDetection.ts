import type { UsageSnapshot, UsageWindow } from "../providers/types";

export interface ResetEvent {
  provider: string;
  windowName: UsageWindow["name"];
}

export function detectResets(
  prev: UsageSnapshot | undefined,
  next: UsageSnapshot
): ResetEvent[] {
  if (next.status !== "ok") return [];
  if (!prev || prev.status !== "ok") return [];

  const events: ResetEvent[] = [];
  for (const nextWindow of next.windows) {
    if (typeof nextWindow.usedPercent !== "number") continue;
    if (nextWindow.usedPercent > 1) continue;

    const prevWindow = prev.windows.find((w) => w.name === nextWindow.name);
    if (!prevWindow || typeof prevWindow.usedPercent !== "number") continue;
    if (prevWindow.usedPercent < 99.5) continue;

    events.push({ provider: next.provider, windowName: nextWindow.name });
  }
  return events;
}
