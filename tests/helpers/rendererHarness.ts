import fs from "node:fs";
import vm from "node:vm";

class FakeClassList {
  private values = new Set<string>();
  add(...items: string[]) { items.forEach((item) => this.values.add(item)); }
  remove(...items: string[]) { items.forEach((item) => this.values.delete(item)); }
  toggle(item: string, force?: boolean) { const on = force ?? !this.values.has(item); if (on) this.values.add(item); else this.values.delete(item); return on; }
  contains(item: string) { return this.values.has(item); }
  toString() { return [...this.values].join(" "); }
}

export class FakeElement {
  textContent = ""; hidden = false; value = ""; disabled = false; dataset: Record<string, string> = {};
  style = { display: "", setProperty() {}, removeProperty() {} } as any;
  classList = new FakeClassList();
  listeners = new Map<string, Array<(...args: any[]) => any>>();
  attributes = new Map<string, string>();
  private html = "";
  parentNode: FakeElement | null = null;
  private _id = "";
  constructor(private readonly document: FakeDocument, id = "", readonly tagName = "div") { this.id = id; }
  set id(value: string) { this._id = value; if (value) this.document.register(value, this); }
  get id() { return this._id; }
  set innerHTML(value: string) { this.html = value; this.document.discover(value, true); }
  get innerHTML() { return this.html; }
  addEventListener(name: string, fn: (...args: any[]) => any) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  async emit(name: string, value: any = {}) {
    if (name === "click" && (this.disabled || this.hidden)) return;
    const event = { currentTarget: this, target: this, ...value };
    for (const fn of this.listeners.get(name) ?? []) await fn(event);
  }
  click() { return this.emit("click"); }
  focus() { this.document.activeElement = this; }
  appendChild(element: FakeElement) {
    element.parentNode = this;
    this.document.track(element);
    return element;
  }
  querySelector(selector: string) { return this.document.querySelector(selector); }
  querySelectorAll(selector: string) { return this.document.querySelectorAll(selector); }
  closest(selector: string) { return this.document.matches(this, selector) ? this : this.document.generic; }
  setAttribute(name: string, value: unknown = "") {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "id") this.id = text;
    if (name === "class") text.split(/\s+/).filter(Boolean).forEach((item) => this.classList.add(item));
    if (name === "disabled") this.disabled = true;
    if (name === "hidden") this.hidden = true;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = text;
    if (name === "style") {
      const display = /(?:^|;)\s*display\s*:\s*([^;]+)/i.exec(text)?.[1]?.trim();
      if (display) this.style.display = display;
    }
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "disabled") this.disabled = false;
    if (name === "hidden") this.hidden = false;
  }
  getAttribute(name: string) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.classList.toString() || null;
    return this.attributes.get(name) ?? null;
  }
  getContext() { return {}; }
  replaceWith() {}
  remove() {}
  insertBefore() {}
  get offsetWidth() { return 1; }
}

export class FakeDocument {
  elements = new Map<string, FakeElement>();
  allElements: FakeElement[] = [];
  generic = new FakeElement(this);
  body = new FakeElement(this, "body");
  activeElement: FakeElement | null = null;
  windowPills = ["7d", "30d", "all"].map((win) => {
    const pill = new FakeElement(this);
    pill.dataset.win = win;
    if (win === "30d") pill.classList.add("active");
    return pill;
  });
  private optionalMissingIds = new Set(["an-noplan-chip"]);
  register(id: string, element: FakeElement) { this.elements.set(id, element); }
  track(element: FakeElement) { if (!this.allElements.includes(element)) this.allElements.push(element); }
  getElementById(id: string) {
    const element = this.elements.get(id);
    if (this.optionalMissingIds.has(id)) return element ?? null;
    return element ?? null;
  }
  createElement() { const element = new FakeElement(this); element.parentNode = this.generic; return element; }
  querySelector(selector: string) {
    if (selector.startsWith("#") && !selector.includes(" ")) return this.elements.get(selector.slice(1).split(/[ .:[>]/)[0]) ?? null;
    if (selector === "#window-pill-grid .pill.active") return this.windowPills.find((pill) => pill.classList.contains("active")) ?? null;
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector = "") {
    if (selector === "#qs-grid .qs-tile-val") return ["qs-api-cost", "qs-roi", "qs-active-days", "qs-session"].map((id) => this.getElementById(id)).filter((item): item is FakeElement => item !== null);
    if (selector === "#window-pill-grid .pill") return this.windowPills;
    const target = selector.trim().split(/\s+/).at(-1) ?? selector;
    return this.allElements.filter((element) => this.matches(element, target));
  }
  matches(element: FakeElement, selector: string) {
    const id = /#([\w-]+)/.exec(selector)?.[1];
    if (id && element.id !== id) return false;
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    if (classes.some((item) => !element.classList.contains(item))) return false;
    for (const match of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
      const actual = element.getAttribute(match[1]);
      if (actual == null || (match[2] != null && actual !== match[2])) return false;
    }
    return Boolean(id || classes.length || selector.includes("["));
  }
  discover(html: string, replaceExisting = false) {
    for (const tag of html.matchAll(/<([a-z][\w-]*)([^>]*)>/gi)) {
      const attrs = new Map<string, string>();
      for (const attr of tag[2].matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        attrs.set(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? "");
      }
      const id = attrs.get("id") ?? "";
      const existing = id ? this.elements.get(id) : undefined;
      const element = existing && !replaceExisting ? existing : new FakeElement(this, id, tag[1].toLowerCase());
      for (const [name, value] of attrs) element.setAttribute(name, value);
      this.track(element);
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
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push(channel);
      invocations.push({ channel, args });
      const next = (responses[channel] ?? []).shift();
      return typeof next === "function" ? await (next as () => unknown)() : await next;
    },
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
