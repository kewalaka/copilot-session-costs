import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { UsageStore } from "../usage.mjs";

test("does not price an external log call from an unattributed zero-AIU legacy match", (t) => {
  const root = mkdtempSync(join(tmpdir(), "external-legacy-cost-"));
  mkdirSync(join(root, "session-state", "session"), { recursive: true });
  const store = new DatabaseSync(":memory:");
  store.exec(`CREATE TABLE assistant_usage_events (
    session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_nano_aiu INTEGER,
    created_at TEXT, duration_ms INTEGER, reasoning_tokens INTEGER, api_endpoint TEXT,
    initiator TEXT, finish_reason TEXT
  )`);
  const timestamp = "2026-10-23T12:00:00.000Z";
  store.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("session", "external-model", 100, 10, 5, 95, 0, timestamp, 1000, 2, "/responses", "user", "stop");
  const external = {
    type: "session.usage_record",
    timestamp,
    data: { usage: {
      model: "external-model",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 95,
      duration: 1000,
      reasoningTokens: 2,
      apiEndpoint: "/responses",
      initiator: "user",
      finishReason: "stop",
      isByok: true,
      accounting: { sourceSessionId: "session", usageId: "external-call" },
    } },
  };
  writeFileSync(join(root, "session-state", "session", "events.jsonl"), `${JSON.stringify(external)}\n`);
  const usage = new UsageStore({ root, store });
  t.after(() => {
    usage.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  usage.refresh();
  const row = usage.db.prepare("SELECT total_nano_aiu FROM assistant_usage_events").get();
  assert.equal(row.total_nano_aiu, null);
  assert.equal(usage.db.prepare("SELECT sum(total_nano_aiu IS NULL) AS count FROM assistant_usage_events").get().count, 1);
});
