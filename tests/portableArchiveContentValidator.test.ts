import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/config/settings";
import { validatePortableArchiveContents } from "../src/portable/archiveContentValidator";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const event = {
  schemaVersion: 1,
  id: hash("event"),
  provider: "claude",
  occurredAt: "2026-07-01T00:00:00.000Z",
  model: "claude-sonnet-4",
  projectName: "QuotaBar",
  sessionKey: hash("session"),
  source: "claude-log",
  synthetic: false,
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  reasoningOutputTokens: 0,
} as const;

const bytes = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const validSettings = { ...defaultSettings, claudeRoots: [], codexHomes: [], proxy: { mode: "auto", url: "" } };

describe("portable archive content validation", () => {
  it("accepts canonical usage, metadata, quota, migration, and settings payloads", () => {
    expect(() => validatePortableArchiveContents([
      { path: "usage/events/2026-07.jsonl", data: bytes(event) },
      { path: "usage/store-metadata.json", data: bytes({
        schemaVersion: 1,
        partitions: { "2026-07": { eventCount: 1, firstAt: event.occurredAt, lastAt: event.occurredAt } },
        updatedAt: "2026-07-02T00:00:00.000Z",
      }) },
      { path: "usage/migration-state.json", data: bytes({
        schemaVersion: 1,
        status: "pending",
        usageMigrationVersion: 0,
        updatedAt: "2026-07-02T00:00:00.000Z",
      }) },
      { path: "quota/snapshots/2026-07.jsonl", data: bytes({
        kind: "snapshot", provider: "claude", status: "ok", windows: [], fetchedAt: event.occurredAt,
      }) },
      { path: "settings.json", data: bytes(validSettings) },
    ])).not.toThrow();
  });

  it.each([
    ["unknown event field", "usage/events/2026-07.jsonl", { ...event, credential: "secret" }],
    ["invalid event hash", "usage/events/2026-07.jsonl", { ...event, id: "event" }],
    ["wrong usage partition", "usage/events/2026-08.jsonl", event],
    ["invalid quota field", "quota/snapshots/2026-07.jsonl", {
      kind: "snapshot", provider: "claude", status: "ok", windows: [], fetchedAt: event.occurredAt, secret: "x",
    }],
    ["wrong quota partition", "quota/snapshots/2026-08.jsonl", {
      kind: "snapshot", provider: "claude", status: "ok", windows: [], fetchedAt: event.occurredAt,
    }],
    ["invalid migration state", "usage/migration-state.json", {
      schemaVersion: 1, status: "complete", usageMigrationVersion: 0, updatedAt: event.occurredAt,
    }],
    ["credential-bearing settings", "settings.json", {
      ...validSettings, proxy: { mode: "manual", url: "http://user:secret@proxy.internal" },
    }],
  ])("rejects %s", (_name, filePath, value) => {
    expect(() => validatePortableArchiveContents([{ path: filePath, data: bytes(value) }]))
      .toThrow("Invalid portable archive contents");
  });

  it("rejects store metadata that does not describe every usage partition", () => {
    expect(() => validatePortableArchiveContents([
      { path: "usage/events/2026-07.jsonl", data: bytes(event) },
      { path: "usage/store-metadata.json", data: bytes({
        schemaVersion: 1,
        partitions: { "2026-07": { eventCount: 2, firstAt: event.occurredAt, lastAt: event.occurredAt } },
        updatedAt: "2026-07-02T00:00:00.000Z",
      }) },
    ])).toThrow("Invalid portable archive contents");
  });
});
