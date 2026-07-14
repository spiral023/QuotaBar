import { describe, expect, it } from "vitest";
import { FakeDocument, rendererHarness } from "./helpers/rendererHarness";

describe("renderer harness DOM topology", () => {
  it("does not create elements from HTML-looking renderer source strings", () => {
    const h = rendererHarness({});

    h.run("src/renderer/tabs/system.js");

    expect(h.document.getElementById("sys-import-restart-retry")).toBeNull();
  });

  it("replaces descendants, scopes queries, and disconnects removed nodes", () => {
    const document = new FakeDocument();
    document.body.innerHTML = `
      <section id="first"><button id="old-button"></button></section>
      <section id="second"><button id="outside-button"></button></section>`;
    const first = document.getElementById("first");
    const oldButton = document.getElementById("old-button");
    if (!first || !oldButton) throw new Error("Initial harness DOM missing");

    expect(first.querySelector("#outside-button")).toBeNull();
    expect(oldButton.isConnected).toBe(true);

    first.innerHTML = '<button id="new-button"></button>';

    expect(oldButton.isConnected).toBe(false);
    expect(document.getElementById("old-button")).toBeNull();
    expect(first.querySelector("#new-button")).toBe(document.getElementById("new-button"));
    expect(document.querySelectorAll("#new-button")).toHaveLength(1);
  });
});
