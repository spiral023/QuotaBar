export interface ShutdownDrainDependencies {
  stopIngestion(): Promise<void>;
  flushNotifications(): Promise<void>;
  flushRecorder(): Promise<void>;
  warn(message: string): void;
}

export function createShutdownDrain(dependencies: ShutdownDrainDependencies): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= drain(dependencies);
    return pending;
  };
}

async function drain(dependencies: ShutdownDrainDependencies): Promise<void> {
  try {
    await dependencies.stopIngestion();
  } catch {
    dependencies.warn("Portable ingestion shutdown failed");
  }
  try {
    await dependencies.flushNotifications();
  } catch {
    dependencies.warn("Notification persistence flush failed during shutdown");
  }
  try {
    await dependencies.flushRecorder();
  } catch {
    dependencies.warn("Debug recorder flush failed during shutdown");
  }
}
