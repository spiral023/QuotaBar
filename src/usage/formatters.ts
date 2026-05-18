export function formatTimeRemaining(resetAt: string | number | Date): string {
  const target = normalizeDate(resetAt);
  const ms = target.getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) {
    return "now";
  }

  const totalMinutes = Math.floor(ms / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  }

  if (totalHours > 0) {
    return minutes > 0 ? `${totalHours}h${minutes}m` : `${totalHours}h`;
  }

  return `${Math.max(1, totalMinutes)}m`;
}

export function usageLine(provider: string, usedPercent?: number, resetsAt?: string): string {
  const usage = typeof usedPercent === "number" ? `${Math.round(usedPercent)}%` : "unknown";
  const reset = resetsAt ? ` (resets in ${formatTimeRemaining(resetsAt)})` : "";
  return `${provider}: ${usage}${reset}`;
}

function normalizeDate(value: string | number | Date): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number") {
    return new Date(value < 10_000_000_000 ? value * 1000 : value);
  }
  return new Date(value);
}
