import type { PlanPeriod } from "../config/settings";
import type { FxLookup } from "./fx-fetcher";

const DAY_MS = 86_400_000;

function localDayBounds(day: string): { start: number; end: number } {
  const start = new Date(`${day}T00:00:00`).getTime(); // lokale Mitternacht
  return { start, end: start + DAY_MS };
}

// Anteil des Tages [start,end), in dem [from,to) aktiv ist (0..1).
function activeFraction(plan: PlanPeriod, dayStart: number, dayEnd: number): number {
  const from = new Date(plan.startsAt).getTime();
  const to = plan.endsAt ? new Date(plan.endsAt).getTime() : Number.POSITIVE_INFINITY;
  const lo = Math.max(from, dayStart);
  const hi = Math.min(to, dayEnd);
  if (hi <= lo) return 0;
  return (hi - lo) / DAY_MS;
}

export function dailySubCostUSD(
  plans: PlanPeriod[], provider: "claude" | "codex", day: string, fx: FxLookup,
): number {
  const { start, end } = localDayBounds(day);
  let sum = 0;
  for (const p of plans) {
    if (p.provider !== provider) continue;
    const frac = activeFraction(p, start, end);
    if (frac <= 0) continue;
    const perDay = (p.amount / 30) * frac;
    sum += p.currency === "EUR" ? perDay * fx.rate("EURUSD", day).value : perDay;
  }
  return sum;
}

export function periodSubCostUSD(
  plans: PlanPeriod[], provider: "claude" | "codex",
  sinceDay: string, untilDay: string, fx: FxLookup,
): number {
  let sum = 0;
  for (const day of eachLocalDay(sinceDay, untilDay)) {
    sum += dailySubCostUSD(plans, provider, day, fx);
  }
  return sum;
}

export interface PlanChangePoint { day: string; provider: "claude" | "codex"; label: string; }

export function planChangePoints(
  plans: PlanPeriod[], provider: "claude" | "codex",
  sinceDay: string, untilDay: string,
): PlanChangePoint[] {
  const inRange = (d: string) => d >= sinceDay && d <= untilDay;
  const mine = plans.filter(p => p.provider === provider);
  const pts: PlanChangePoint[] = [];
  for (const p of mine) {
    const startDay = p.startsAt.slice(0, 10);
    if (inRange(startDay)) {
      const ended = mine.find(q => q.id !== p.id && q.endsAt && q.endsAt.slice(0, 10) === startDay);
      const overlapping = mine.some(q => q.id !== p.id && q.startsAt < p.startsAt && (!q.endsAt || q.endsAt > p.startsAt));
      const label = ended ? `${ended.name} → ${p.name}` : overlapping ? `+ ${p.name}` : p.name;
      pts.push({ day: startDay, provider, label });
    }
    if (p.endsAt) {
      const endDay = p.endsAt.slice(0, 10);
      const replaced = mine.some(q => q.id !== p.id && q.startsAt.slice(0, 10) === endDay);
      if (inRange(endDay) && !replaced) pts.push({ day: endDay, provider, label: `${p.name} endet` });
    }
  }
  return pts.sort((a, b) => a.day.localeCompare(b.day));
}

function eachLocalDay(sinceDay: string, untilDay: string): string[] {
  const pad = (v: number) => String(v).padStart(2, "0");
  const start = new Date(`${sinceDay}T00:00:00`);
  const end = new Date(`${untilDay}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const days: string[] = [];
  for (let i = 0; i < 100_000; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    if (d > end) break;
    days.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return days;
}
