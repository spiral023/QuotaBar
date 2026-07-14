import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("pending portable import startup", () => {
  it("applies pending data inside whenReady before first-run and settings reads", async () => {
    const source = await readFile(path.resolve("src/main/main.ts"), "utf8");
    const whenReady = source.indexOf("app.whenReady()");
    const applyPending = source.indexOf("await applyPendingImport(getAppConfigDir())", whenReady);
    const firstRun = source.indexOf("await isFirstRun()", whenReady);
    const settings = source.indexOf("await loadSettings(", whenReady);

    expect(whenReady).toBeGreaterThan(-1);
    expect(applyPending).toBeGreaterThan(whenReady);
    expect(applyPending).toBeLessThan(firstRun);
    expect(applyPending).toBeLessThan(settings);
  });

  it("logs a stable rollback status and aborts normal startup when pending apply fails", async () => {
    const source = await readFile(path.resolve("src/main/main.ts"), "utf8");
    const applyPending = source.indexOf("await applyPendingImport(getAppConfigDir())");
    const firstRun = source.indexOf("await isFirstRun()", applyPending);
    const guardedStartup = source.slice(applyPending, firstRun);

    expect(guardedStartup).toContain("rollback=");
    expect(guardedStartup).toContain("throw new Error(\"Portable pending import apply failed\")");
  });
});
