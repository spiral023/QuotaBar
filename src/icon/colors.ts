export type UsageColor = "green" | "yellow" | "orange" | "red";

const colorMap: Record<UsageColor | "gray", string> = {
  gray: "#787878",
  green: "#52d017",
  yellow: "#ffd700",
  orange: "#ff8c00",
  red: "#ff4444"
};

export function getUsageColor(percent: number): UsageColor {
  if (percent < 50) return "green";
  if (percent < 75) return "yellow";
  if (percent < 90) return "orange";
  return "red";
}

export function getUsageColorHex(color: UsageColor | "gray"): string {
  return colorMap[color];
}

export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ];
}
