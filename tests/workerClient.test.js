"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_events_1 = require("node:events");
const vitest_1 = require("vitest");
const workerClient_1 = require("../src/main/workerClient");
class FakeWorker extends node_events_1.EventEmitter {
    posted = [];
    unrefCalled = false;
    postMessage(value) {
        this.posted.push(value);
    }
    unref() {
        this.unrefCalled = true;
    }
}
function createClient() {
    const workers = [];
    const client = new workerClient_1.PersistentWorkerClient(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    });
    return { client, workers };
}
(0, vitest_1.describe)("PersistentWorkerClient", () => {
    (0, vitest_1.it)("resolves a request with the matching response result", async () => {
        const { client, workers } = createClient();
        const promise = client.request({ task: "summary" });
        const [worker] = workers;
        const { id } = worker.posted[0];
        worker.emit("message", { id, ok: true, result: { value: 42 } });
        await (0, vitest_1.expect)(promise).resolves.toEqual({ value: 42 });
    });
    (0, vitest_1.it)("routes out-of-order responses to the correct callers", async () => {
        const { client, workers } = createClient();
        const first = client.request({ task: "summary" });
        const second = client.request({ task: "get" });
        const [worker] = workers;
        const firstId = worker.posted[0].id;
        const secondId = worker.posted[1].id;
        worker.emit("message", { id: secondId, ok: true, result: "B" });
        worker.emit("message", { id: firstId, ok: true, result: "A" });
        await (0, vitest_1.expect)(first).resolves.toBe("A");
        await (0, vitest_1.expect)(second).resolves.toBe("B");
    });
    (0, vitest_1.it)("rejects when the worker reports a failure", async () => {
        const { client, workers } = createClient();
        const promise = client.request({ task: "summary" });
        const [worker] = workers;
        const { id } = worker.posted[0];
        worker.emit("message", { id, ok: false, error: "boom" });
        await (0, vitest_1.expect)(promise).rejects.toThrow("boom");
    });
    (0, vitest_1.it)("reuses the same worker across sequential requests", async () => {
        const { client, workers } = createClient();
        const first = client.request({ task: "summary" });
        workers[0].emit("message", { id: workers[0].posted[0].id, ok: true, result: 1 });
        await first;
        const second = client.request({ task: "summary" });
        workers[0].emit("message", { id: workers[0].posted[1].id, ok: true, result: 2 });
        await (0, vitest_1.expect)(second).resolves.toBe(2);
        (0, vitest_1.expect)(workers).toHaveLength(1);
    });
    (0, vitest_1.it)("rejects pending requests on worker exit and respawns on the next request", async () => {
        const { client, workers } = createClient();
        const pending = client.request({ task: "summary" });
        workers[0].emit("exit", 1);
        await (0, vitest_1.expect)(pending).rejects.toThrow(/exited/);
        const retry = client.request({ task: "summary" });
        (0, vitest_1.expect)(workers).toHaveLength(2);
        workers[1].emit("message", { id: workers[1].posted[0].id, ok: true, result: "ok" });
        await (0, vitest_1.expect)(retry).resolves.toBe("ok");
    });
    (0, vitest_1.it)("rejects pending requests on worker error and respawns on the next request", async () => {
        const { client, workers } = createClient();
        const pending = client.request({ task: "summary" });
        workers[0].emit("error", new Error("thread crashed"));
        await (0, vitest_1.expect)(pending).rejects.toThrow("thread crashed");
        const retry = client.request({ task: "summary" });
        (0, vitest_1.expect)(workers).toHaveLength(2);
        workers[1].emit("message", { id: workers[1].posted[0].id, ok: true, result: "ok" });
        await (0, vitest_1.expect)(retry).resolves.toBe("ok");
    });
    (0, vitest_1.it)("unrefs the worker so it does not keep the process alive", () => {
        const { client, workers } = createClient();
        void client.request({ task: "summary" }).catch(() => { });
        (0, vitest_1.expect)(workers[0].unrefCalled).toBe(true);
    });
});
