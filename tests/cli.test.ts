import { describe, expect, it } from "vitest";
import { parseRuntimeCliArgs } from "../src/main/cli";

describe("runtime CLI arguments", () => {
  it.each(["--open-window", "--no-window", "--debug", "--install-startup", "--uninstall-startup"])("retains the first packaged argument %s", (flag) => {
    expect(parseRuntimeCliArgs(["QuotaBar.exe", flag], true))
      .toEqual(parseRuntimeCliArgs(["electron.exe", ".", flag], false));
  });

  it("opens the installed dashboard when requested as the first argument", () => {
    expect(parseRuntimeCliArgs(["QuotaBar.exe", "--open-window", "--remote-debugging-port=18766"], true).openWindow).toBe(true);
  });

  it("reads the first packaged numeric argument and ignores runtime switches", () => {
    expect(parseRuntimeCliArgs(["QuotaBar.exe", "--poll-interval-seconds", "90", "--remote-debugging-port=18766"], true))
      .toMatchObject({ pollIntervalSeconds: 90, debug: false, openWindow: false });
  });

  it("does not interpret the development app path as a flag", () => {
    expect(parseRuntimeCliArgs(["electron.exe", "--debug", "--open-window"], false)).toMatchObject({ debug: false, openWindow: true });
  });
});
