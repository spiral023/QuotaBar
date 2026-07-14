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
  textContent = ""; hidden = false; value = ""; disabled = false; checked = false; dataset: Record<string, string> = {};
  style = { display: "", setProperty() {}, removeProperty() {} } as any;
  classList = new FakeClassList();
  listeners = new Map<string, Array<(...args: any[]) => any>>();
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  private html = "";
  parentNode: FakeElement | null = null;
  private _id = "";
  constructor(private readonly document: FakeDocument, id = "", readonly tagName = "div") { this.id = id; }
  set id(value: string) { this._id = value; }
  get id() { return this._id; }
  get isConnected() { return this.document.isConnected(this); }
  set innerHTML(value: string) { this.html = value; this.document.replaceChildrenFromHtml(this, value); }
  get innerHTML() { return this.html; }
  addEventListener(name: string, fn: (...args: any[]) => any) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  async emit(name: string, value: any = {}) {
    if (name === "click" && (this.disabled || this.hidden)) return;
    const event = { currentTarget: this, target: this, ...value };
    for (const fn of this.listeners.get(name) ?? []) await fn(event);
  }
  click() { return this.emit("click"); }
  focus() { if (this.isConnected && !this.disabled && !this.hidden) this.document.activeElement = this; }
  appendChild(element: FakeElement) {
    return this.document.appendChild(this, element);
  }
  querySelector(selector: string) { return this.document.queryWithin(this, selector)[0] ?? null; }
  querySelectorAll(selector: string) { return this.document.queryWithin(this, selector); }
  closest(selector: string) {
    if (this.document.matchesSimple(this, selector)) return this;
    for (let node = this.parentNode; node; node = node.parentNode) {
      if (this.document.matchesSimple(node, selector)) return node;
    }
    return null;
  }
  setAttribute(name: string, value: unknown = "") {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "id") this.id = text;
    if (name === "class") text.split(/\s+/).filter(Boolean).forEach((item) => this.classList.add(item));
    if (name === "disabled") this.disabled = true;
    if (name === "checked") this.checked = true;
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
    if (name === "checked") this.checked = false;
    if (name === "hidden") this.hidden = false;
  }
  getAttribute(name: string) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.classList.toString() || null;
    return this.attributes.get(name) ?? null;
  }
  getContext() { return {}; }
  replaceWith(element: FakeElement) { this.document.replace(this, element); }
  remove() { this.document.remove(this); }
  insertBefore(element: FakeElement, reference: FakeElement | null) { return this.document.insertBefore(this, element, reference); }
  get offsetWidth() { return 1; }
}

export class FakeDocument {
  generic = new FakeElement(this);
  body = new FakeElement(this, "body", "body");
  activeElement: FakeElement | null = null;
  windowPills: FakeElement[] = [];
  loadHtml(html: string) {
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
    this.body.innerHTML = body;
    this.windowPills = this.querySelectorAll("#window-pill-grid .pill");
  }
  getElementById(id: string) {
    return this.descendants(this.body).find((element) => element.id === id) ?? null;
  }
  createElement(tagName = "div") { return new FakeElement(this, "", tagName.toLowerCase()); }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector = "") {
    return this.queryWithin(this.body, selector);
  }
  queryWithin(root: FakeElement, selector: string) {
    const selectors = selector.split(",").map((item) => item.trim()).filter(Boolean);
    return this.descendants(root).filter((element) => selectors.some((item) => this.matchesPath(element, item, root)));
  }
  matchesPath(element: FakeElement, selector: string, boundary: FakeElement) {
    const parts = selector.trim().split(/\s+/);
    if (!this.matchesSimple(element, parts.pop() ?? "")) return false;
    let ancestor = element.parentNode;
    while (parts.length) {
      const expected = parts.pop();
      while (ancestor && ancestor !== boundary.parentNode && !this.matchesSimple(ancestor, expected ?? "")) ancestor = ancestor.parentNode;
      if (!ancestor || ancestor === boundary.parentNode) return false;
      ancestor = ancestor.parentNode;
    }
    return true;
  }
  matchesSimple(element: FakeElement, selector: string) {
    const id = /#([\w-]+)/.exec(selector)?.[1];
    if (id && element.id !== id) return false;
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    if (classes.some((item) => !element.classList.contains(item))) return false;
    for (const match of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
      const actual = element.getAttribute(match[1]);
      if (actual == null || (match[2] != null && actual !== match[2])) return false;
    }
    if (selector.includes(":checked") && !element.checked) return false;
    const tag = /^([a-z][\w-]*)/i.exec(selector)?.[1];
    if (tag && element.tagName !== tag.toLowerCase()) return false;
    return Boolean(tag || id || classes.length || selector.includes("["));
  }
  descendants(root: FakeElement) {
    const result: FakeElement[] = [];
    const visit = (parent: FakeElement) => {
      for (const child of parent.children) { result.push(child); visit(child); }
    };
    visit(root);
    return result;
  }
  isConnected(element: FakeElement) {
    if (element === this.body) return true;
    for (let node = element.parentNode; node; node = node.parentNode) if (node === this.body) return true;
    return false;
  }
  appendChild(parent: FakeElement, element: FakeElement) {
    element.remove();
    element.parentNode = parent;
    parent.children.push(element);
    return element;
  }
  insertBefore(parent: FakeElement, element: FakeElement, reference: FakeElement | null) {
    element.remove();
    element.parentNode = parent;
    const index = reference ? parent.children.indexOf(reference) : -1;
    if (index < 0) parent.children.push(element); else parent.children.splice(index, 0, element);
    return element;
  }
  replace(current: FakeElement, replacement: FakeElement) {
    const parent = current.parentNode;
    if (!parent) return;
    this.insertBefore(parent, replacement, current);
    this.remove(current);
  }
  remove(element: FakeElement) {
    const parent = element.parentNode;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== element);
    element.parentNode = null;
    if (this.activeElement === element || this.descendants(element).includes(this.activeElement)) this.activeElement = null;
  }
  replaceChildrenFromHtml(owner: FakeElement, html: string) {
    for (const child of [...owner.children]) this.remove(child);
    const stack = [owner];
    const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    for (const token of html.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
      const full = token[0];
      const tagName = token[1].toLowerCase();
      if (full.startsWith("</")) {
        while (stack.length > 1) {
          const closed = stack.pop();
          if (closed?.tagName === tagName) break;
        }
        continue;
      }
      const element = new FakeElement(this, "", tagName);
      for (const attr of token[2].matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        element.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? "");
      }
      this.appendChild(stack.at(-1) ?? owner, element);
      if (!voidTags.has(tagName) && !full.endsWith("/>")) stack.push(element);
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
  document.loadHtml(fs.readFileSync("src/renderer/index.html", "utf8"));
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
  return { context, QB, document, calls, invocations, handlers, timers, run(file: string) { const code = fs.readFileSync(file, "utf8"); vm.runInContext(code, context); } };
}

export async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); }
