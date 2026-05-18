import { log } from "./logging";

export async function initializeUpdater(): Promise<void> {
  log.debug("Updater is not enabled in the MVP build");
}
