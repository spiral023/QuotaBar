import * as fs from "node:fs/promises";
import path from "node:path";
import { withAppDataLock } from "../portable/appDataLock";

interface Entry { file: string; line: string; bytes: number }

/** Bounded asynchronous logging; slow or unavailable storage cannot block the tray. */
export class AsyncLogWriter {
  private queue: Entry[] = [];
  private bytes = 0;
  private dropped = 0;
  private overflowFile = "";
  private pending?: Promise<void>;

  constructor(private readonly capacity = 1_048_576, private readonly maxFileBytes = 5_000_000) {
    if (!Number.isInteger(capacity) || capacity < 1 || maxFileBytes <= capacity) throw new Error("Invalid log buffer limits");
  }

  write(file: string, line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.bytes + bytes > this.capacity) { this.dropped++; this.overflowFile = file; }
    else { this.queue.push({ file, line, bytes }); this.bytes += bytes; }
    this.schedule();
  }

  async flush(): Promise<void> { while (this.pending) await this.pending; }

  private schedule(): void {
    this.pending ??= Promise.resolve().then(() => this.drain()).finally(() => {
      this.pending = undefined;
      if (this.queue.length || this.dropped) this.schedule();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length || this.dropped) {
      const first = this.queue.shift() ?? { file: this.overflowFile, line: "", bytes: 0 };
      this.bytes -= first.bytes;
      let batch = first.line;
      while (this.queue[0]?.file === first.file && Buffer.byteLength(batch) < 65_536) {
        const next = this.queue.shift()!; this.bytes -= next.bytes; batch += next.line;
      }
      if (this.dropped) {
        batch += `${new Date().toISOString()} WARN Logger dropped ${this.dropped} messages because its buffer was full\n`;
        this.dropped = 0;
      }
      try {
        await withAppDataLock(path.dirname(first.file), async () => {
          const stat = await fs.stat(first.file).catch(() => undefined);
          if (stat && stat.size + Buffer.byteLength(batch) >= this.maxFileBytes) {
            const content = await fs.readFile(first.file);
            const start = Math.max(0, content.length - Math.floor(this.maxFileBytes * 0.7));
            let tail = content.subarray(start);
            const newline = tail.indexOf(0x0a);
            if (start > 0 && newline >= 0 && newline + 1 < tail.length) tail = tail.subarray(newline + 1);
            await fs.writeFile(first.file, tail);
          }
          await fs.appendFile(first.file, batch, "utf8");
        });
      } catch { /* Logging must never crash the tray or reject the shutdown drain. */ }
    }
  }
}
