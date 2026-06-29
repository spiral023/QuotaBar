import { describe, expect, it } from "vitest";
import { detectAgents, type AgentProbe } from "../src/main/onboarding";

function probe(overrides: Partial<AgentProbe>): AgentProbe {
  return {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    logo: "../../logos/claude.png",
    hasCredentials: async () => false,
    hasDataDirs: () => false,
    ...overrides,
  };
}

describe("detectAgents", () => {
  it("meldet 'connected', wenn Credentials vorhanden sind", async () => {
    const agents = await detectAgents([probe({ hasCredentials: async () => true })]);
    expect(agents[0].status).toBe("connected");
  });

  it("meldet 'detected', wenn nur Datenverzeichnisse existieren", async () => {
    const agents = await detectAgents([probe({ hasDataDirs: () => true })]);
    expect(agents[0].status).toBe("detected");
  });

  it("meldet 'not_found', wenn weder Credentials noch Daten existieren", async () => {
    const agents = await detectAgents([probe({})]);
    expect(agents[0].status).toBe("not_found");
  });

  it("wertet einen Credentials-Fehler als nicht angemeldet, nicht als Absturz", async () => {
    const agents = await detectAgents([
      probe({
        hasCredentials: async () => { throw new Error("EACCES"); },
        hasDataDirs: () => true,
      }),
    ]);
    expect(agents[0].status).toBe("detected");
  });

  it("behält Reihenfolge und Metadaten der Probes bei", async () => {
    const agents = await detectAgents([
      probe({ id: "claude", name: "Claude Code", vendor: "Anthropic" }),
      probe({ id: "codex", name: "Codex", vendor: "OpenAI", logo: "../../logos/codex.png" }),
    ]);
    expect(agents.map(a => a.id)).toEqual(["claude", "codex"]);
    expect(agents[1]).toMatchObject({ name: "Codex", vendor: "OpenAI", logo: "../../logos/codex.png" });
  });
});
