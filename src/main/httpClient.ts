import net from "node:net";
import { log } from "./logging";
import { normalizeProxySettings, type ProxySettings } from "../config/settings";

// Central egress client. By default this uses global fetch (Node/undici, direct
// connect). When a proxy is configured or detected, requests go through Electron's
// Chromium network stack (session.fetch) instead. This handles two common
// corporate network requirements: authenticated proxy egress and TLS inspection
// with the Windows certificate store.

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const PROBE_HOST = "127.0.0.1";
const PROBE_PORT = 3128; // Px default; final fallback in auto mode.

let proxiedFetch: FetchFn | null = null;
let activeProxyUrl: string | null = null;

/** Currently active proxy URL, or null for direct egress. */
export function getActiveProxyUrl(): string | null {
  return activeProxyUrl;
}

/**
 * Resolves proxy settings and configures the dedicated Chromium session used for
 * egress. Safe to call repeatedly after settings changes because fromPartition
 * returns the same session. Must run after app.whenReady().
 */
export async function configureHttpProxy(proxy: ProxySettings): Promise<string | null> {
  activeProxyUrl = await resolveProxyUrl(proxy);

  if (!activeProxyUrl) {
    proxiedFetch = null;
    log.info("HTTP egress: direct (no proxy active)");
    return null;
  }

  try {
    const { session } = await import("electron");
    const egress = session.fromPartition("quotabar-egress");
    await egress.setProxy({ proxyRules: activeProxyUrl, proxyBypassRules: "<local>" });
    proxiedFetch = (input, init) => egress.fetch(input, init) as unknown as Promise<Response>;
    log.info(`HTTP egress: via proxy ${activeProxyUrl} (Chromium net stack, system CA trust)`);
  } catch (error) {
    // Proxy setup must never block startup or the Live tab; fall back to direct.
    proxiedFetch = null;
    activeProxyUrl = null;
    log.warn(`HTTP proxy setup failed, falling back to direct: ${error instanceof Error ? error.message : String(error)}`);
  }
  return activeProxyUrl;
}

/** Drop-in replacement for global fetch; routes via the proxy session when active. */
export function httpFetch(input: string, init?: RequestInit): Promise<Response> {
  if (proxiedFetch) return proxiedFetch(input, init);
  return fetch(input, init);
}

async function resolveProxyUrl(proxy: ProxySettings): Promise<string | null> {
  const { mode, url } = normalizeProxySettings(proxy);
  if (mode === "off") return null;
  if (mode === "manual") return sanitizeProxyUrl(url);

  // auto: first common proxy env vars, then a local Px-style proxy probe.
  const fromEnv = sanitizeProxyUrl(
    process.env.HTTPS_PROXY ?? process.env.https_proxy ??
    process.env.HTTP_PROXY ?? process.env.http_proxy ??
    process.env.ALL_PROXY ?? process.env.all_proxy ?? ""
  );
  if (fromEnv) return fromEnv;

  if (await canConnect(PROBE_HOST, PROBE_PORT)) return `http://${PROBE_HOST}:${PROBE_PORT}`;
  return null;
}

/** Normalizes proxy input to "scheme://host:port" or null when unusable. */
function sanitizeProxyUrl(raw: string): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    const u = new URL(withScheme);
    if (!u.host) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Fast TCP probe: a local proxy is immediately reachable or absent. */
function canConnect(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}
