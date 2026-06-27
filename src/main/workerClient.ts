/**
 * Request/response multiplexer over a long-lived worker thread.
 *
 * Keeping the worker alive between requests preserves its module-level
 * caches (e.g. FileParseCache in the JSONL readers), so repeat analytics
 * requests only re-stat files instead of re-parsing the full history.
 */
export interface WorkerLike {
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(value: unknown): void;
  unref(): void;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class PersistentWorkerClient {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly createWorker: () => WorkerLike) {}

  request(payload: Record<string, unknown>): Promise<unknown> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, ...payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.on("message", value => this.handleMessage(worker, value));
    worker.on("error", err => this.failAll(worker, err));
    worker.on("exit", code => this.failAll(worker, new Error(`Analytics worker exited with code ${code}`)));
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private handleMessage(worker: WorkerLike, value: unknown): void {
    if (this.worker !== worker) return;
    const msg = value as WorkerResponse;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error ?? "Worker request failed"));
  }

  /** Worker died — reject everything in flight and respawn lazily on next request. */
  private failAll(worker: WorkerLike, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}
