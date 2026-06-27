import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { PersistentWorkerClient, type WorkerLike } from "../src/main/workerClient";

class FakeWorker extends EventEmitter implements WorkerLike {
  posted: Array<Record<string, unknown>> = [];
  unrefCalled = false;

  postMessage(value: unknown): void {
    this.posted.push(value as Record<string, unknown>);
  }

  unref(): void {
    this.unrefCalled = true;
  }
}

function createClient(): { client: PersistentWorkerClient; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const client = new PersistentWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  return { client, workers };
}

describe("PersistentWorkerClient", () => {
  it("resolves a request with the matching response result", async () => {
    const { client, workers } = createClient();
    const promise = client.request({ task: "summary" });
    const [worker] = workers;
    const { id } = worker.posted[0];
    worker.emit("message", { id, ok: true, result: { value: 42 } });
    await expect(promise).resolves.toEqual({ value: 42 });
  });

  it("routes out-of-order responses to the correct callers", async () => {
    const { client, workers } = createClient();
    const first = client.request({ task: "summary" });
    const second = client.request({ task: "get" });
    const [worker] = workers;
    const firstId = worker.posted[0].id;
    const secondId = worker.posted[1].id;
    worker.emit("message", { id: secondId, ok: true, result: "B" });
    worker.emit("message", { id: firstId, ok: true, result: "A" });
    await expect(first).resolves.toBe("A");
    await expect(second).resolves.toBe("B");
  });

  it("rejects when the worker reports a failure", async () => {
    const { client, workers } = createClient();
    const promise = client.request({ task: "summary" });
    const [worker] = workers;
    const { id } = worker.posted[0];
    worker.emit("message", { id, ok: false, error: "boom" });
    await expect(promise).rejects.toThrow("boom");
  });

  it("reuses the same worker across sequential requests", async () => {
    const { client, workers } = createClient();
    const first = client.request({ task: "summary" });
    workers[0].emit("message", { id: workers[0].posted[0].id, ok: true, result: 1 });
    await first;
    const second = client.request({ task: "summary" });
    workers[0].emit("message", { id: workers[0].posted[1].id, ok: true, result: 2 });
    await expect(second).resolves.toBe(2);
    expect(workers).toHaveLength(1);
  });

  it("rejects pending requests on worker exit and respawns on the next request", async () => {
    const { client, workers } = createClient();
    const pending = client.request({ task: "summary" });
    workers[0].emit("exit", 1);
    await expect(pending).rejects.toThrow(/exited/);

    const retry = client.request({ task: "summary" });
    expect(workers).toHaveLength(2);
    workers[1].emit("message", { id: workers[1].posted[0].id, ok: true, result: "ok" });
    await expect(retry).resolves.toBe("ok");
  });

  it("rejects pending requests on worker error and respawns on the next request", async () => {
    const { client, workers } = createClient();
    const pending = client.request({ task: "summary" });
    workers[0].emit("error", new Error("thread crashed"));
    await expect(pending).rejects.toThrow("thread crashed");

    const retry = client.request({ task: "summary" });
    expect(workers).toHaveLength(2);
    workers[1].emit("message", { id: workers[1].posted[0].id, ok: true, result: "ok" });
    await expect(retry).resolves.toBe("ok");
  });

  it("ignores a late exit from an old worker after a new worker has been spawned", async () => {
    const { client, workers } = createClient();
    const pending = client.request({ task: "summary" });
    workers[0].emit("error", new Error("thread crashed"));
    await expect(pending).rejects.toThrow("thread crashed");

    const retry = client.request({ task: "summary" });
    expect(workers).toHaveLength(2);
    workers[0].emit("exit", 1);
    workers[1].emit("message", { id: workers[1].posted[0].id, ok: true, result: "ok" });

    await expect(retry).resolves.toBe("ok");
  });

  it("unrefs the worker so it does not keep the process alive", () => {
    const { client, workers } = createClient();
    void client.request({ task: "summary" }).catch(() => {});
    expect(workers[0].unrefCalled).toBe(true);
  });
});
