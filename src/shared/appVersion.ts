import { createRequire } from "node:module";

/** Read the package metadata at runtime so exports and releases share one version. */
export const appVersion = (createRequire(__filename)("../../package.json") as { version: string }).version;
