import fs from "node:fs/promises";
import path from "node:path";
import { redactPII } from "../shared/redaction";
import type { DebugEvent } from "./debugEvents";

interface RecorderOptions {
  enabled: boolean;
  logDir: string;
}

export class DebugRecorder {
  private enabled: boolean;
  private readonly logDir: string;
  private chain: Promise<unknown> = Promise.resolve();
  private dirEnsured = false;
  private lastErrorMs = 0;

  constructor(opts: RecorderOptions) {
    this.enabled = opts.enabled;
    this.logDir = opts.logDir;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  write(event: DebugEvent): void {
    if (!this.enabled) return;
    const ts = new Date();
    const line = this.serialize(ts, event);
    const filePath = path.join(this.logDir, `${utcDateKey(ts)}.jsonl`);
    this.append(filePath, line);
  }

  writeBackfill(dateKey: string, event: DebugEvent): void {
    if (!this.enabled) return;
    const line = this.serialize(new Date(), event);
    const filePath = path.join(this.logDir, `${dateKey}.backfill.jsonl`);
    this.append(filePath, line);
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  private serialize(ts: Date, event: DebugEvent): string {
    const redacted = redactPII({ ts: ts.toISOString(), ...event });
    return `${JSON.stringify(redacted)}\n`;
  }

  private append(filePath: string, line: string): void {
    this.chain = this.chain.then(async () => {
      try {
        if (!this.dirEnsured) {
          await fs.mkdir(this.logDir, { recursive: true });
          this.dirEnsured = true;
        }
        await fs.appendFile(filePath, line, "utf8");
      } catch (err) {
        this.reportError(filePath, err);
      }
    });
  }

  private reportError(filePath: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorMs < 60_000) return;
    this.lastErrorMs = now;
    console.error(`DebugRecorder failed to append to ${filePath}:`, err);
  }
}

function utcDateKey(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
