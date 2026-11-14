export function formatPathListForLog(value: unknown): string {
  if (!Array.isArray(value)) return "[]";
  const paths = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return paths.length ? `[${paths.join(", ")}]` : "[]";
}
