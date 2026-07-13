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
  parentNode: FakeElement | null = null;
  private _id = "";
  constructor(private readonly document: FakeDocument, id = "") { this.id = id; }
  set id(value: string) { this._id = value; if (value) this.document.register(value, this); }
  get id() { return this._id; }
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
  insertBefore() {}
  get offsetWidth() { return 1; }
}

export class FakeDocument {
  elements = new Map<string, FakeElement>();
  generic = new FakeElement(this);
  body = new FakeElement(this, "body");
  windowPills = ["7d", "30d", "all"].map((win) => {
    const pill = new FakeElement(this);
    pill.dataset.win = win;
    if (win === "30d") pill.classList.add("active");
    return pill;
  });
  private optionalMissingIds = new Set(["an-noplan-chip"]);
  register(id: string, element: FakeElement) { this.elements.set(id, element); }
  getElementById(id: string) {
    const element = this.elements.get(id);
    if (this.optionalMissingIds.has(id)) return element ?? null;
    if (!element) throw new Error(`Renderer harness: missing DOM element #${id}`);
    return element;
  }
  createElement() { const element = new FakeElement(this); element.parentNode = this.generic; return element; }
  querySelector(selector: string) {
    if (selector.startsWith("#")) return this.getElementById(selector.slice(1).split(/[ .:[>]/)[0]);
    if (selector === "#window-pill-grid .pill.active") return this.windowPills.find((pill) => pill.classList.contains("active")) ?? null;
    const el = this.generic; if (selector.includes(".pill.active")) el.dataset.win = "30d"; return el;
  }
  querySelectorAll(selector = "") {
    if (selector === "#qs-grid .qs-tile-val") return ["qs-api-cost", "qs-roi", "qs-active-days", "qs-session"].map((id) => this.getElementById(id));
    if (selector === "#window-pill-grid .pill") return this.windowPills;
    return [] as FakeElement[];
  }
  discover(html: string) {
    for (const match of html.matchAll(/id=["']([^"']+)["']/g)) {
      if (!this.elements.has(match[1])) this.elements.set(match[1], new FakeElement(this, match[1]));
    }
  }
}

export class FakeTimers {
  private now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, delay = 0) => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + Math.max(0, delay), fn });
    return id;
  };
  clearTimeout = (id: number) => { this.tasks.delete(id); };
  pendingCount() { return this.tasks.size; }
  advanceBy(ms: number) {
    const end = this.now + ms;
    while (true) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }
}

export function rendererHarness(responses: Record<string, unknown[]>) {
  const document = new FakeDocument();
  document.discover(fs.readFileSync("src/renderer/index.html", "utf8"));
  const timers = new FakeTimers();
  const calls: string[] = [];
  const invocations: Array<{ channel: string; args: unknown[] }> = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = {
    invoke: async (channel: string, ...args: unknown[]) => { calls.push(channel); invocations.push({ channel, args }); const queue = responses[channel] ?? []; return queue.shift(); },
    on: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
    send() {},
  };
  const qbTarget: Record<string, any> = {
    ipc, esc: (v: unknown) => String(v ?? ""), fmtTokens: (v: unknown) => String(v ?? 0),
    shortModelName: (v: unknown) => String(v ?? ""), roiColor: () => "", providerColor: () => "#000",
    usageColor: () => "#000", accentVar: () => "#000", formatCountdown: () => "",
    charts: {
      createLine: () => ({ destroy() {}, update() {} }), createDoughnut: () => ({ destroy() {}, update() {} }),
      createStackedBar: () => ({ destroy() {}, update() {} }), mapChangesToIndex: () => [],
      mutedTextColor: "#000", planChangePlugin: {},
    }, settings: {},
  };
  const QB = qbTarget;
  const Chart = class { data: any; options: any; constructor(_ctx: any, config: any) { this.data = config.data; this.options = config.options; } destroy() {} update() {} };
  const context = vm.createContext({
    window: { QB }, QB, document, console, Chart, Intl, Date, Math, JSON, Promise,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} }, ResizeObserver: class { observe() {} disconnect() {} },
  });
  return { context, QB, document, calls, invocations, handlers, timers, run(file: string) { const code = fs.readFileSync(file, "utf8"); document.discover(code); vm.runInContext(code, context); } };
}

export async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); }
