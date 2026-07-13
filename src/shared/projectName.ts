export function basenameAnySeparator(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!trimmed || hasControlCharacter) return undefined;

  const isUnc = /^(?:\\\\|\/\/)/.test(trimmed);
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  if (isUnc && parts.length <= 2) return undefined;
  if (parts.length === 1 && /^[A-Za-z]:/.test(parts[0])) return undefined;

  const basename = parts.at(-1)?.trim();
  if (!basename || basename === "." || basename === "..") return undefined;
  if (/^[A-Za-z]--/.test(basename) || basename.startsWith("-")) return undefined;
  return basename;
}

export function plainClaudeProjectName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const basename = basenameAnySeparator(trimmed);
  if (!basename || basename !== trimmed) return undefined;
  return basename;
}
