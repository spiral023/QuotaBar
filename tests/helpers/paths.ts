import path from "node:path";

/**
 * Normalizes a path for equality assertions. Windows drive letters are case-
 * insensitive, but `process.cwd()` keeps whatever casing the launching shell
 * used (VS Code starts terminals in `c:\`), while module paths use `C:\`.
 */
export function comparablePath(value: unknown): string {
  const normalized = path.normalize(String(value));
  return process.platform === "win32"
    ? normalized.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
    : normalized;
}
