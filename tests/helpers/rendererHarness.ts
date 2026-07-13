import fs from "node:fs";
import vm from "node:vm";

class FakeClassList {
  private values = new Set<string>();
  add(...items: string[]) { items.forEach((item) => this.values.add(item)); }
  remove(...items: string[]) { items.forEach((item) => this.values.delete(item)); }
  toggle(item: string, force?: boolean) { const on = force ?? !this.values.has(item); if (on) this.values.add(item); else this.values.delete(item); return on; }
  contains(item: string) { return this.values.has(item); }
}

export class FakeElement {
  textContent = ""; hidden = false; value = ""; disabled = false; dataset: Record<string, string> = {};
  style = { setProperty() {}, removeProperty() {} } as any;
  classList = new FakeClassList();
  listeners = new Map<string, Array<(...args: any[]) => any>>();
  private html = "";
  constructor(private readonly document: FakeDocument, public readonly id = "") {}
  set innerHTML(value: string) { this.html = value; this.document.discover(value); }
  get innerHTML() { return this.html; }
  addEventListener(name: string, fn: (...args: any[]) => any) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  async emit(name: string, value: any = {}) { for (const fn of this.listeners.get(name) ?? []) await fn(value); }
  querySelector(selector: string) { return this.document.querySelector(selector); }
  querySelectorAll(selector: string) { return this.document.querySelectorAll(selector); }
  closest() { return this.document.generic; }
  setAttribute() {}
  getAttribute() { return null; }
  getContext() { return {}; }
  replaceWith() {}
  remove() {}
  get offsetWidth() { return 1; }
}

export class FakeDocument {
  elements = new Map<string, FakeElement>();
  generic = new FakeElement(this);
  body = new FakeElement(this, "body");
  getElementById(id: string) { if (!this.elements.has(id)) this.elements.set(id, new FakeElement(this, id)); return this.elements.get(id)!; }
  querySelector(selector: string) {
    if (selector.startsWith("#")) return this.getElementById(selector.slice(1).split(/[ .:[>]/)[0]);
    const el = this.generic; if (selector.includes(".pill.active")) el.dataset.win = "30d"; return el;
  }
  querySelectorAll(selector = "") {
    if (selector === "#qs-grid .qs-tile-val") return ["qs-api-cost", "qs-roi", "qs-active-days", "qs-session"].map((id) => this.getElementById(id));
    return [] as FakeElement[];
  }
  discover(html: string) { for (const match of html.matchAll(/id=["']([^"']+)["']/g)) this.getElementById(match[1]); }
}

export function rendererHarness(responses: Record<string, unknown[]>) {
  const document = new FakeDocument();
  const calls: string[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = {
    invoke: async (channel: string) => { calls.push(channel); const queue = responses[channel] ?? []; return queue.shift(); },
    on: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
    send() {},
  };
  const qbTarget: Record<string, any> = {
    ipc, esc: (v: unknown) => String(v ?? ""), fmtTokens: (v: unknown) => String(v ?? 0),
    shortModelName: (v: unknown) => String(v ?? ""), roiColor: () => "", providerColor: () => "#000",
    charts: {
      createLine: () => ({ destroy() {}, update() {} }), createDoughnut: () => ({ destroy() {}, update() {} }),
      createStackedBar: () => ({ destroy() {}, update() {} }), mapChangesToIndex: () => [],
      mutedTextColor: "#000", planChangePlugin: {},
    }, settings: {},
  };
  const QB = new Proxy(qbTarget, { get(target, prop) { return prop in target ? target[prop as string] : (() => undefined); } });
  const Chart = class { data: any; options: any; constructor(_ctx: any, config: any) { this.data = config.data; this.options = config.options; } destroy() {} update() {} };
  const context = vm.createContext({
    window: { QB }, QB, document, console, Chart, Intl, Date, Math, JSON, Promise,
    setTimeout: (fn: () => void) => { fn(); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} }, ResizeObserver: class { observe() {} disconnect() {} },
  });
  return { context, QB, document, calls, handlers, run(file: string) { vm.runInContext(fs.readFileSync(file, "utf8"), context); } };
}

export async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); }
