import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Runs once in the main Vitest process. Workers inherit the environment and
 * create their per-file homes below this root, so removing it at the end also
 * removes homes whose afterAll never ran, such as fully skipped files.
 */
export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quotabar-test-homes-"));
  process.env.QUOTABAR_TEST_HOME_ROOT = root;
  return () => {
    fs.rmSync(root, { recursive: true, force: true });
  };
}
