const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Entfernt ein optionales führendes "v" und prüft das SemVer-Format. */
export function parseTagVersion(tag: string): string {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!SEMVER.test(version)) {
    throw new Error(`Tag "${tag}" ist keine gültige SemVer-Version (erwartet vX.Y.Z)`);
  }
  return version;
}

/** Wirft, wenn der Git-Tag nicht exakt der package.json-Version entspricht. */
export function assertTagMatches(tag: string, version: string): void {
  const tagVersion = parseTagVersion(tag);
  if (tagVersion !== version) {
    throw new Error(
      `Versions-Mismatch: Git-Tag ergibt ${tagVersion}, package.json hat ${version}. ` +
        `Tag und package.json-Version müssen übereinstimmen.`,
    );
  }
}
