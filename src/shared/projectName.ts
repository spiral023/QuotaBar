export function basenameAnySeparator(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1);
}
