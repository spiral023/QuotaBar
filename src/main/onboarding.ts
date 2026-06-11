import { getClaudeProjectsDirs, getCodexSessionsDirs } from "../config/paths";
import type { UsageProvider } from "../providers/types";

export type AgentDetectionStatus = "connected" | "detected" | "not_found";

export interface DetectedAgent {
  id: string;
  name: string;
  vendor: string;
  /** Logo-Pfad relativ zu src/renderer/ (wie in live.js). */
  logo: string;
  status: AgentDetectionStatus;
}

export interface AgentProbe {
  id: string;
  name: string;
  vendor: string;
  logo: string;
  hasCredentials(): Promise<boolean>;
  hasDataDirs(): boolean;
}

export async function detectAgents(probes: AgentProbe[]): Promise<DetectedAgent[]> {
  return Promise.all(probes.map(async (p) => {
    let connected = false;
    try {
      connected = await p.hasCredentials();
    } catch {
      connected = false;
    }
    const status: AgentDetectionStatus = connected
      ? "connected"
      : p.hasDataDirs() ? "detected" : "not_found";
    return { id: p.id, name: p.name, vendor: p.vendor, logo: p.logo, status };
  }));
}

export function defaultAgentProbes(providers: UsageProvider[]): AgentProbe[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const meta: Array<Omit<AgentProbe, "hasCredentials" | "hasDataDirs"> & { dataDirs: () => string[] }> = [
    { id: "claude", name: "Claude Code", vendor: "Anthropic", logo: "../../logos/claude.png", dataDirs: () => getClaudeProjectsDirs() },
    { id: "codex",  name: "Codex",       vendor: "OpenAI",    logo: "../../logos/codex.png",  dataDirs: () => getCodexSessionsDirs() },
  ];
  return meta.map(({ dataDirs, ...m }) => ({
    ...m,
    hasCredentials: () => byId.get(m.id)?.isAvailable() ?? Promise.resolve(false),
    hasDataDirs: () => dataDirs().length > 0,
  }));
}
