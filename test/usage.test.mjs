import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { UsageStore } from "../usage.mjs";

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "session-costs-test-"));
  const state = join(root, "session-state");
  mkdirSync(state);
  const path = join(root, "session-store.db");
  const writer = new DatabaseSync(path);
  const schema = `CREATE TABLE assistant_usage_events (
    session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_nano_aiu INTEGER,
    created_at TEXT, duration_ms INTEGER, reasoning_tokens INTEGER, api_endpoint TEXT,
    initiator TEXT, finish_reason TEXT
  )`;
  if (!options.noLegacyTable) writer.exec(schema);
  const store = new DatabaseSync(path, { readOnly: true });
  const usage = new UsageStore({
    root, store,
    getParents: () => options.parents ?? new Map(),
    readLog: options.readLog,
  });
  let insert = options.noLegacyTable ? null : writer.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  t.after(() => {
    usage.close();
    store.close();
    writer.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    usage,
    createLegacyTable() {
      writer.exec(schema);
      insert = writer.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    },
    legacy(sessionId, event, time = event.timestamp) {
      const u = event.data.usage;
      insert.run(sessionId, u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens,
        u.copilotUsage?.totalNanoAiu ?? null, time, u.duration, u.reasoningTokens, u.apiEndpoint,
        u.initiator, u.finishReason);
    },
    log(sessionId, events) {
      const directory = join(state, sessionId);
      mkdirSync(directory, { recursive: true });
      const file = join(directory, "events.jsonl");
      writeFileSync(file, events.map(JSON.stringify).join("\n") + "\n");
      return file;
    },
    rows() {
      return usage.db.prepare("SELECT * FROM assistant_usage_events ORDER BY created_at, session_id").all();
    },
  };
}

function event(sessionId, usageId, timestamp, overrides = {}) {
  return {
    type: "session.usage_record",
    timestamp,
    data: {
      usage: {
        model: "model",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 95,
        duration: 1000,
        reasoningTokens: 2,
        apiEndpoint: "/responses",
        initiator: "user",
        finishReason: "stop",
        isByok: false,
        copilotUsage: { totalNanoAiu: 1000000000 },
        accounting: { sourceSessionId: sessionId, usageId },
        ...overrides,
      },
    },
  };
}

test("reconciles interleaved SQLite and JSONL calls without a cutoff", (t) => {
  const f = fixture(t);
  const first = event("mixed", "a", "2026-10-23T12:00:00.000Z");
  const external = event("mixed", "b", "2026-10-23T12:00:01.000Z", {
    model: "private-model", isByok: true, modelProvider: "azure_openai", copilotUsage: undefined,
  });
  const last = event("mixed", "c", "2026-10-23T12:00:02.000Z", { inputTokens: 300 });
  f.legacy("mixed", first, "2026-10-23T12:00:00.001Z");
  f.legacy("mixed", last);
  f.log("mixed", [first, external, last]);
  f.usage.refresh();
  const rows = f.rows();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.billing_source), ["copilot", "external", "copilot"]);
  assert.equal(rows[1].provider, "azure_openai");
  assert.equal(rows[1].total_nano_aiu, null);
});

test("matches legacy events one-to-one and retains distinct calls with equal token counts", (t) => {
  const f = fixture(t);
  const first = event("same", "a", "2026-10-23T12:00:00.000Z");
  const second = event("same", "b", "2026-10-23T12:00:00.000Z");
  const differentDuration = event("same", "c", "2026-10-23T12:00:00.005Z", { duration: 2000 });
  f.legacy("same", first);
  f.log("same", [first, second, differentDuration]);
  f.usage.refresh();
  assert.equal(f.rows().length, 3);
});

test("reassigns overlapping legacy matches to avoid double-counting neighboring calls", (t) => {
  const f = fixture(t);
  const first = event("same", "a", "2026-10-23T12:00:00.009Z");
  const second = event("same", "b", "2026-10-23T12:00:00.018Z");
  const third = event("same", "c", "2026-10-23T12:00:00.027Z");
  f.legacy("same", first, "2026-10-23T12:00:00.000Z");
  f.legacy("same", second, "2026-10-23T12:00:00.009Z");
  f.legacy("same", third, "2026-10-23T12:00:00.018Z");
  f.log("same", [first, second, third]);
  f.usage.refresh();
  assert.equal(f.rows().length, 3);
  assert.deepEqual(f.rows().map((row) => row.billing_source), ["copilot", "copilot", "copilot"]);
});

test("keeps nearby legacy and log calls separate when their available details differ", (t) => {
  const f = fixture(t);
  const legacy = event("same", "a", "2026-10-23T12:00:00.000Z");
  const logged = event("same", "b", "2026-10-23T12:00:00.001Z", { duration: 2000 });
  f.legacy("same", legacy);
  f.log("same", [logged]);
  f.usage.refresh();
  assert.equal(f.rows().length, 2);
});

test("does not match distinct events outside the timestamp tolerance", (t) => {
  const f = fixture(t);
  const old = event("same", "a", "2026-10-23T12:00:00.000Z");
  const newer = event("same", "b", "2026-10-23T12:00:00.011Z");
  f.legacy("same", old);
  f.log("same", [newer]);
  f.usage.refresh();
  assert.equal(f.rows().length, 2);
});

test("deduplicates parent and child copies and assigns them to the original or ancestor", (t) => {
  const f = fixture(t, { parents: new Map([["child", "parent"]]) });
  const parent = event("parent", "a", "2026-10-23T12:00:00.000Z");
  const internal = event("internal-agent", "b", "2026-10-23T12:00:01.000Z");
  const child = event("child", "c", "2026-10-23T12:00:02.000Z");
  f.log("parent", [parent, internal]);
  f.log("child", [parent, internal, child]);
  f.usage.refresh();
  assert.deepEqual(f.rows().map((row) => row.session_id), ["parent", "parent", "child"]);
  assert.deepEqual(f.usage.warnings, []);
});

test("does not merge unidentifiable records from different sessions", (t) => {
  const f = fixture(t);
  const unidentifiable = event("unused", "unused", "2026-10-23T12:00:00.000Z", {
    accounting: {}, apiCallId: undefined,
  });
  f.log("one", [unidentifiable]);
  f.log("two", [unidentifiable]);
  f.usage.refresh();
  assert.equal(f.rows().length, 2);
  assert.match(f.usage.warnings.join(" "), /without a stable ID/);
});

test("warns when a usage ID lacks the source needed for cross-session deduplication", (t) => {
  const f = fixture(t);
  const copy = event("unused", "unused", "2026-10-23T12:00:00.000Z", {
    accounting: { usageId: "shared" },
  });
  f.log("one", [copy]);
  f.log("two", [copy]);
  f.usage.refresh();
  assert.equal(f.rows().length, 2);
  assert.match(f.usage.warnings.join(" "), /without an accounting source/);
});

test("reconciles an overlapping legacy call copied into parent and child logs", (t) => {
  const f = fixture(t, { parents: new Map([["child", "parent"]]) });
  const shared = event("parent", "shared", "2026-10-23T12:00:00.000Z");
  f.legacy("parent", shared);
  f.legacy("child", shared);
  const parentLog = f.log("parent", [shared]);
  f.log("child", [shared]);
  f.usage.refresh();
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].session_id, "parent");
  unlinkSync(parentLog);
  f.usage.refresh();
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].session_id, "parent");
});

test("only reads changed logs and removes deleted logs", (t) => {
  const reads = [];
  const f = fixture(t, { readLog: (file) => { reads.push(file); return readFileSync(file, "utf8"); } });
  const one = event("one", "a", "2026-10-23T12:00:00.000Z");
  const two = event("two", "b", "2026-10-23T12:00:01.000Z");
  const oneFile = f.log("one", [one]);
  const twoFile = f.log("two", [two]);
  f.usage.refresh();
  assert.equal(reads.length, 2);
  reads.length = 0;
  f.usage.refresh();
  assert.deepEqual(reads, []);
  appendFileSync(oneFile, JSON.stringify(event("one", "c", "2026-10-23T12:00:02.000Z")) + "\n");
  f.usage.refresh();
  assert.deepEqual(reads, [oneFile]);
  assert.equal(f.rows().length, 3);
  unlinkSync(twoFile);
  f.usage.refresh();
  assert.equal(f.rows().length, 2);
});

test("reports unreadable and malformed logs while retaining the last successful read", (t) => {
  let deny = false;
  const f = fixture(t, { readLog: (file) => {
    if (deny) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return readFileSync(file, "utf8");
  } });
  const file = f.log("one", [event("one", "a", "2026-10-23T12:00:00.000Z")]);
  f.usage.refresh();
  appendFileSync(file, '{"type":"session.usage_record",\n');
  deny = true;
  f.usage.refresh();
  assert.equal(f.rows().length, 1);
  assert.match(f.usage.warnings.join(" "), /permission denied/);
  deny = false;
  f.usage.refresh();
  assert.equal(f.rows().length, 1);
  assert.match(f.usage.warnings.join(" "), /malformed JSONL line/);
});

test("warns when a JSONL line is truncated before the usage event type is complete", (t) => {
  const f = fixture(t);
  const file = f.log("one", []);
  writeFileSync(file, '{"type":"session.usage_rec');
  f.usage.refresh();
  assert.equal(f.rows().length, 0);
  assert.match(f.usage.warnings.join(" "), /1 malformed JSONL line/);
});

test("refreshes legacy database changes made by another connection", (t) => {
  const f = fixture(t);
  f.usage.refresh();
  assert.equal(f.rows().length, 0);
  f.legacy("legacy", event("legacy", "a", "2026-10-23T12:00:00.000Z"));
  f.usage.refresh();
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].billing_source, "unknown");
});

test("uses session logs if the legacy table is missing and notices when it appears", (t) => {
  const f = fixture(t, { noLegacyTable: true });
  const call = event("one", "a", "2026-10-23T12:00:00.000Z");
  f.log("one", [call]);
  f.usage.refresh();
  assert.equal(f.rows().length, 1);
  assert.match(f.usage.warnings.join(" "), /Legacy usage table is missing/);
  f.createLegacyTable();
  f.legacy("one", call);
  f.usage.refresh();
  assert.equal(f.rows().length, 1);
  assert.deepEqual(f.usage.warnings, []);
});

test("surfaces conflicting copies of the same usage identity", (t) => {
  const f = fixture(t, { parents: new Map([["child", "parent"]]) });
  const original = event("parent", "a", "2026-10-23T12:00:00.000Z");
  const conflict = event("parent", "a", "2026-10-23T12:00:00.000Z", { inputTokens: 200 });
  f.log("parent", [original]);
  f.log("child", [conflict]);
  f.usage.refresh();
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].input_tokens, 100);
  assert.match(f.usage.warnings.join(" "), /conflicting data/);
});
