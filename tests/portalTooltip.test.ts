import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

class FakeNode {
  parent: FakeElement | null = null;
}

class FakeElement extends FakeNode {
  id = "";
  className = "";
  textContent = "";
  innerHTML = "";
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  rect = { left: 0, top: 0, width: 0, height: 0, bottom: 0 };
  /** Width the tooltip would get if laid out at style.left (shrink-to-fit near the edge). */
  widthAt: (left: number) => number = () => 0;

  readonly classList = {
    add: (name: string) => { if (!this.className.split(" ").includes(name)) this.className = `${this.className} ${name}`.trim(); },
    remove: (name: string) => { this.className = this.className.split(" ").filter((item) => item !== name).join(" "); },
    contains: (name: string) => this.className.split(" ").includes(name),
  };

  constructor(readonly matchesSelector = false) { super(); }
  get offsetWidth(): number { return this.widthAt(parseFloat(this.style.left ?? "0") || 0); }
  get offsetHeight(): number { return 40; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  appendChild(child: FakeElement): void { child.parent = this; this.children.push(child); }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string, event: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  contains(node: unknown): boolean {
    for (let current = node as FakeNode | null; current; current = current.parent) if (current === this) return true;
    return false;
  }
  closest(): FakeElement | null {
    return this.matchesSelector ? this : this.parent?.closest() ?? null;
  }
  getBoundingClientRect() { return this.rect; }
}

interface PortalTip {
  show(anchor: FakeElement, content: string | null, options?: { variant?: string; html?: string }): void;
  hide(): void;
  bindDataTips(container: FakeElement, selector: string): void;
}

function loadTooltip() {
  const body = new FakeElement();
  const document = {
    body,
    getElementById: (id: string) => body.children.find((child) => child.id === id) ?? null,
    createElement: () => new FakeElement(),
  };
  const qb: { portalTip?: PortalTip } = {};
  const window = { innerWidth: 300, QB: qb };
  const context = vm.createContext({ window, QB: qb, document, Element: FakeElement, Node: FakeNode });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "shared", "tooltip.js"), "utf8"), context);
  const portalTip = qb.portalTip!;
  const tip = () => document.getElementById("qb-portal-tip") as FakeElement | null;
  return { body, portalTip, tip };
}

function anchorIn(container: FakeElement, text: string, left = 100): FakeElement {
  const anchor = new FakeElement(true);
  anchor.setAttribute("data-tip", text);
  anchor.rect = { left, top: 200, width: 20, height: 20, bottom: 220 };
  container.appendChild(anchor);
  return anchor;
}

describe("shared portal tooltip", () => {
  it("shows on hover and keyboard focus and hides on leave", () => {
    const { portalTip, tip } = loadTooltip();
    const container = new FakeElement();
    const anchor = anchorIn(container, "Explains the tile");
    portalTip.bindDataTips(container, ".x");

    container.dispatch("mouseover", { target: anchor });
    expect(tip()?.textContent).toBe("Explains the tile");
    expect(tip()?.classList.contains("is-visible")).toBe(true);
    container.dispatch("mouseout", { target: anchor, relatedTarget: null });
    expect(tip()?.classList.contains("is-visible")).toBe(false);

    container.dispatch("focusin", { target: anchor });
    expect(tip()?.classList.contains("is-visible")).toBe(true);
    container.dispatch("focusout", { target: anchor, relatedTarget: null });
    expect(tip()?.classList.contains("is-visible")).toBe(false);
  });

  it("binds a container only once per selector", () => {
    const { portalTip } = loadTooltip();
    const container = new FakeElement();
    portalTip.bindDataTips(container, ".x");
    portalTip.bindDataTips(container, ".x");
    portalTip.bindDataTips(container, ".y");

    expect(container.listeners.get("mouseover")).toHaveLength(2);
    expect(container.listeners.get("focusin")).toHaveLength(2);
  });

  it("measures at the origin so a tooltip near the right edge keeps its margin", () => {
    const { body, portalTip, tip } = loadTooltip();
    const anchor = anchorIn(new FakeElement(), "Near the edge", 280);
    portalTip.show(anchor, "first");
    // Simulate shrink-to-fit: laid out at x, the box only gets the remaining width.
    tip()!.widthAt = (left) => Math.min(120, 300 - left);
    tip()!.style.left = "250px";

    portalTip.show(anchor, "Near the edge");

    expect(tip()!.style.left).toBe(`${300 - 120 - 6}px`);
    expect(body.children).toHaveLength(1);
  });

  it("uses the rows variant only for markup and resets it for plain text", () => {
    const { portalTip, tip } = loadTooltip();
    const anchor = anchorIn(new FakeElement(), "plain");

    portalTip.show(anchor, null, { variant: "rows", html: "<div class=\"hr-tok-tip-row\"></div>" });
    expect(tip()!.className).toContain("qb-portal-tip--rows");
    expect(tip()!.innerHTML).toContain("hr-tok-tip-row");

    portalTip.show(anchor, "<b>not markup</b>");
    expect(tip()!.className).not.toContain("qb-portal-tip--rows");
    expect(tip()!.textContent).toBe("<b>not markup</b>");
  });
});
