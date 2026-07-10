import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCodexAuthJson, resolveCodexCredentials } from "../src/auth/codexAuth";

describe("parseCodexAuthJson", () => {
  it("reads nested Codex CLI access tokens", () => {
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: "tok_nested" } }));

    expect(parsed?.accessToken).toBe("tok_nested");
  });

  it("reads root access tokens and extracts account id from JWT", () => {
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth.chatgpt_account_id": "acct_root"
    })).toString("base64url");

    const parsed = parseCodexAuthJson(JSON.stringify({ access_token: `h.${payload}.s` }));

    expect(parsed?.accessToken).toContain(".");
    expect(parsed?.accountId).toBe("acct_root");
  });

  it("extracts email from id_token nested under tokens", () => {
    const idToken = "x." + Buffer.from(JSON.stringify({ email: "dev@example.com" })).toString("base64url") + ".y";
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: "tok", id_token: idToken } }));

    expect(parsed?.email).toBe("dev@example.com");
  });

  it("leaves email undefined when id_token is absent", () => {
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: "tok" } }));

    expect(parsed?.email).toBeUndefined();
  });

  it("leaves email undefined and does not throw when id_token is not a valid JWT", () => {
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: "tok", id_token: "garbage" } }));

    expect(parsed?.email).toBeUndefined();
  });

  it("extracts expiresAt in milliseconds from the access token exp claim", () => {
    const expSeconds = 1_800_000_000;
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: jwtWithClaims({ exp: expSeconds }) } }));

    expect(parsed?.expiresAt).toBe(expSeconds * 1000);
  });

  it("leaves expiresAt undefined when the token has no exp claim", () => {
    const parsed = parseCodexAuthJson(JSON.stringify({ tokens: { access_token: "tok_opaque" } }));

    expect(parsed?.expiresAt).toBeUndefined();
  });
});

describe("resolveCodexCredentials", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function makeHome(auth?: object): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quotabar-codex-"));
    tempDirs.push(dir);
    if (auth) {
      await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify(auth), "utf8");
    }
    return dir;
  }

  function context(homes: string[]) {
    return { codexHomes: homes, homeDir: path.join(os.tmpdir(), "quotabar-no-home"), env: {} };
  }

  const NOW = 1_750_000_000_000;

  it("skips an expired token and falls back to a valid one from a later home", async () => {
    const expired = await makeHome({ tokens: { access_token: jwtWithClaims({ exp: (NOW - 60_000) / 1000 }) } });
    const valid = await makeHome({ tokens: { access_token: jwtWithClaims({ exp: (NOW + 86_400_000) / 1000, marker: "valid" }) } });

    const result = await resolveCodexCredentials(context([expired, valid]), NOW);

    expect(result.state).toBe("ok");
    expect(result.credentials?.accessToken).toContain(".");
    expect(result.path).toBe(path.join(valid, "auth.json"));
  });

  it("prefers the valid token with the latest expiry", async () => {
    const sooner = await makeHome({ tokens: { access_token: jwtWithClaims({ exp: (NOW + 3_600_000) / 1000 }) } });
    const later = await makeHome({ tokens: { access_token: jwtWithClaims({ exp: (NOW + 86_400_000) / 1000 }) } });

    const result = await resolveCodexCredentials(context([sooner, later]), NOW);

    expect(result.state).toBe("ok");
    expect(result.path).toBe(path.join(later, "auth.json"));
  });

  it("treats tokens without an exp claim as usable", async () => {
    const opaque = await makeHome({ tokens: { access_token: "tok_opaque" } });

    const result = await resolveCodexCredentials(context([opaque]), NOW);

    expect(result.state).toBe("ok");
    expect(result.credentials?.accessToken).toBe("tok_opaque");
  });

  it("prefers a token with a known valid expiry over one without exp claim", async () => {
    const opaque = await makeHome({ tokens: { access_token: "tok_opaque" } });
    const known = await makeHome({ tokens: { access_token: jwtWithClaims({ exp: (NOW + 86_400_000) / 1000 }) } });

    const result = await resolveCodexCredentials(context([opaque, known]), NOW);

    expect(result.path).toBe(path.join(known, "auth.json"));
  });

  it("reports state expired when every candidate token is expired", async () => {
    const expiredA = await makeHome({ tokens: { access_token: jwtWithClaims({ exp: (NOW - 60_000) / 1000 }) } });
    const expiredB = await makeHome({ tokens: { access_token: jwtWithClaims({ exp: (NOW - 120_000) / 1000 }) } });

    const result = await resolveCodexCredentials(context([expiredA, expiredB]), NOW);

    expect(result.state).toBe("expired");
    expect(result.credentials).toBeNull();
    expect(result.path).toBe(path.join(expiredA, "auth.json"));
  });

  it("reports state missing when no auth.json exists anywhere", async () => {
    const empty = await makeHome();

    const result = await resolveCodexCredentials(context([empty]), NOW);

    expect(result.state).toBe("missing");
    expect(result.credentials).toBeNull();
  });

  it("ignores unreadable auth.json files and still uses valid ones", async () => {
    const broken = await makeHome();
    await fs.writeFile(path.join(broken, "auth.json"), "not json", "utf8");
    const valid = await makeHome({ tokens: { access_token: jwtWithClaims({ exp: (NOW + 86_400_000) / 1000 }) } });

    const result = await resolveCodexCredentials(context([broken, valid]), NOW);

    expect(result.state).toBe("ok");
    expect(result.path).toBe(path.join(valid, "auth.json"));
  });
});

function jwtWithClaims(claims: Record<string, unknown>): string {
  return "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
}
