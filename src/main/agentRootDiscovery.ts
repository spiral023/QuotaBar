import type { Settings } from "../config/settings";
import {
  discoverWslAgentRoots,
  type WslAgentDiscovery,
} from "./systemData";

export interface AgentRoots {
  claudeRoots: string[];
  codexHomes: string[];
}

const emptyAgentRoots = (): AgentRoots => ({ claudeRoots: [], codexHomes: [] });

let runtimeAgentRoots: AgentRoots = emptyAgentRoots();

export function getRuntimeAgentRoots(): AgentRoots {
  return {
    claudeRoots: [...runtimeAgentRoots.claudeRoots],
    codexHomes: [...runtimeAgentRoots.codexHomes],
  };
}

export function setRuntimeAgentRoots(roots: AgentRoots): void {
  runtimeAgentRoots = {
    claudeRoots: uniquePaths(roots.claudeRoots),
    codexHomes: uniquePaths(roots.codexHomes),
  };
}

export function agentRootsFromWslDiscovery(discovery: WslAgentDiscovery): AgentRoots {
  return {
    claudeRoots: uniquePaths(discovery.claudeRoots.map((item) => item.path)),
    codexHomes: uniquePaths(discovery.codexHomes.map((item) => item.path)),
  };
}

export function mergeSettingsWithAgentRoots(settings: Settings, roots = getRuntimeAgentRoots()): Settings {
  return {
    ...settings,
    claudeRoots: uniquePaths([...(settings.claudeRoots ?? []), ...roots.claudeRoots]),
    codexHomes: uniquePaths([...(settings.codexHomes ?? []), ...roots.codexHomes]),
  };
}

export async function refreshRuntimeWslAgentRoots(platform = process.platform): Promise<{
  discovery: WslAgentDiscovery;
  roots: AgentRoots;
}> {
  const discovery = await discoverWslAgentRoots(platform);
  const roots = agentRootsFromWslDiscovery(discovery);
  setRuntimeAgentRoots(roots);
  return { discovery, roots };
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of paths) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
