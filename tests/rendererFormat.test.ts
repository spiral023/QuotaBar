import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function loadFormatHelpers(): { shortModelName: (model: string) => string } {
  const qb = {};
  const context = vm.createContext({
    window: { QB: qb },
    QB: qb,
  });
  const script = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "shared", "format.js"), "utf8");
  vm.runInContext(script, context);
  return context.QB as { shortModelName: (model: string) => string };
}

describe("renderer format helpers", () => {
  it("keeps the gpt prefix when shortening model names", () => {
    const { shortModelName } = loadFormatHelpers();

    expect(shortModelName("gpt-5.5")).toBe("gpt-5.5");
    expect(shortModelName("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(shortModelName("claude-sonnet-4-6")).toBe("sonnet-4-6");
  });
});
