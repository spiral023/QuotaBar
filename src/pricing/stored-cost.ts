import type { CostComponents } from "../reports/types";
import { ZERO_BREAKDOWN } from "./cost-calculator";

export function reconcileStoredCost(item: CostComponents & { costUSD?: number }): {
  costUSD: number;
  inputCostUSD: number;
  outputCostUSD: number;
  cacheCreationCostUSD: number;
  cacheReadCostUSD: number;
} {
  const input = Math.max(0, item.inputCostUSD ?? 0);
  const output = Math.max(0, item.outputCostUSD ?? 0);
  const creation = Math.max(0, item.cacheCreationCostUSD ?? 0);
  const read = Math.max(0, item.cacheReadCostUSD ?? 0);
  const componentSum = input + output + creation + read;
  const total = Math.max(0, item.costUSD ?? componentSum);
  if (total === 0) {
    return { costUSD: 0, ...ZERO_BREAKDOWN };
  }
  if (componentSum === 0) {
    return { costUSD: total, ...ZERO_BREAKDOWN, outputCostUSD: total };
  }
  if (componentSum === total) {
    return {
      costUSD: total,
      inputCostUSD: input,
      outputCostUSD: output,
      cacheCreationCostUSD: creation,
      cacheReadCostUSD: read,
    };
  }
  if (componentSum > total) {
    const scale = total / componentSum;
    const inputCostUSD = input * scale;
    const outputCostUSD = output * scale;
    const cacheCreationCostUSD = creation * scale;
    const cacheReadCostUSD = Math.max(0, total - inputCostUSD - outputCostUSD - cacheCreationCostUSD);
    return { costUSD: total, inputCostUSD, outputCostUSD, cacheCreationCostUSD, cacheReadCostUSD };
  }
  const inputCostUSD = input;
  const cacheCreationCostUSD = creation;
  const cacheReadCostUSD = read;
  const outputCostUSD = Math.max(0, total - inputCostUSD - cacheCreationCostUSD - cacheReadCostUSD);
  return { costUSD: total, inputCostUSD, outputCostUSD, cacheCreationCostUSD, cacheReadCostUSD };
}
