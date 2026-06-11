/** Strips Claude-style date suffixes: claude-haiku-4-5-20251001 → claude-haiku-4-5 */
const DATE_SUFFIX = /-20\d{6}$/;

export function normalizeModelName(model: string): string {
  return model.replace(DATE_SUFFIX, "");
}

/** Zero-cost artifacts that must not appear in charts or tables. */
export function isIgnoredModel(model: string): boolean {
  return model === "<synthetic>" || model === "unknown" || model === "";
}
