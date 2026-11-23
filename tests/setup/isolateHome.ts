import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Code under test resolves its data directory from os.homedir() (for example
// ~/.quotabar-win/cache/historical-model-prices.json). Without this, tests that
// fall back to default paths read the developer's real data, which makes their
// results machine-dependent, and write test prices into the real files.
// The root comes from tests/setup/testHomeRoot.ts, which removes it at the end.
const root = process.env.QUOTABAR_TEST_HOME_ROOT ?? os.tmpdir();
const home = fs.mkdtempSync(path.join(root, "home-"));
process.env.USERPROFILE = home;
process.env.HOME = home;

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
