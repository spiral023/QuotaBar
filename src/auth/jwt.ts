export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return undefined;
  }

  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function decodeJwtClaim(token: string, claimName: string): unknown {
  return decodeJwtPayload(token)?.[claimName];
}
