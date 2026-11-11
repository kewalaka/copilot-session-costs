import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { createSessionCosts } from "../server.mjs";

test("serves reconciled and separately attributed usage without rereading unchanged logs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-costs-server-test-"));
  const state = join(root, "session-state");
  mkdirSync(state);
  const store = new DatabaseSync(join(root, "session-store.db"));
  const app = new DatabaseSync(join(root, "data.db"));
  let costs, running;
  t.after(async () => {
    if (running) await new Promise((resolve) => running.server.close(resolve));
    if (costs) costs.close();
    store.close();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.exec(`
    CREATE TABLE assistant_usage_events (
      session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_nano_aiu INTEGER,
      created_at TEXT, duration_ms INTEGER
    );
    CREATE TABLE sessions (id TEXT, summary TEXT, repository TEXT);
  `);
  app.exec(`
    CREATE TABLE sessions (id TEXT, title TEXT);
    CREATE TABLE workspaces (session_id TEXT, creator_session_id TEXT);
    INSERT INTO sessions VALUES ('parent', 'Example session'), ('child', 'Child session');
    INSERT INTO workspaces VALUES ('child', 'parent');
  `);
  const makeEvent = (sessionId, id, timestamp, external = false) => ({
    type: "session.usage_record",
    timestamp,
    data: { usage: {
      model: "shared-model",
      inputTokens: external ? 200 : 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 100,
      duration: 1000,
      isByok: external,
      modelProvider: external ? "azure_openai" : undefined,
      modelDisplayName: external ? "APIM / shared-model" : undefined,
      copilotUsage: external ? undefined : { totalNanoAiu: 1000000000 },
      accounting: { sourceSessionId: sessionId, usageId: id },
    } },
  });
  const first = makeEvent("parent", "first", "2026-10-23T12:00:00.000Z");
  const external = makeEvent("parent", "external", "2026-10-23T12:00:01.000Z", true);
  const last = makeEvent("parent", "last", "2026-10-23T12:00:02.000Z");
  const child = makeEvent("child", "child", "2026-10-23T12:00:03.000Z", true);
  const insert = store.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const event of [first, last]) {
    const u = event.data.usage;
    insert.run("parent", u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens,
      u.copilotUsage.totalNanoAiu, event.timestamp, u.duration);
  }
  for (const [id, events] of [["parent", [first, external, last]], ["child", [external, child]]]) {
    mkdirSync(join(state, id));
    writeFileSync(join(state, id, "events.jsonl"), events.map(JSON.stringify).join("\n") + "\n");
  }
  const reads = [];
  const update = {
    version: "0.2.0",
    notesUrl: "https://github.com/kewalaka/copilot-session-costs/releases/tag/v0.2.0",
    installUrl: "https://github.com/kewalaka/copilot-session-costs/tree/v0.2.0",
  };
  let requested = 0;
  costs = createSessionCosts({
    root, readLog: (file) => { reads.push(file); return readFileSync(file, "utf8"); },
    updates: { check: async () => ({ currentVersion: "0.1.0", update, error: null }) },
  });
  running = await costs.start({ requestUpgrade: async (release) => { assert.deepEqual(release, update); requested++; } });
  assert.equal(reads.length, 2);

  const get = async (path) => {
    const response = await fetch(new URL(path, running.url));
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await get("/api/update")).update.version, "0.2.0");
  assert.equal((await get("/api/update")).requested, false);
  const upgradeUrl = new URL("/api/upgrade", running.url);
  assert.equal((await fetch(upgradeUrl)).status, 405);
  assert.equal((await fetch(upgradeUrl, { method: "POST" })).status, 403);
  assert.equal((await fetch(upgradeUrl, {
    method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" },
  })).status, 403);
  const postUpgrade = () => fetch(upgradeUrl, {
    method: "POST", headers: { Origin: new URL(running.url).origin, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(requested, 0);
  for (const response of await Promise.all([postUpgrade(), postUpgrade()])) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).requested, true);
  }
  assert.equal(requested, 1);
  assert.equal((await get("/api/update")).requested, true);
  const sessions = (await get("/api/sessions")).rows;
  assert.equal(sessions.find((row) => row.id === "parent").calls, 3);
  assert.equal(sessions.find((row) => row.id === "child").calls, 1);
  assert.equal(sessions.find((row) => row.id === "child").parent, "parent");

  const details = (await get("/api/session?id=parent")).rows;
  assert.equal(details.length, 2);
  const copilot = details.find((row) => row.billing_source === "copilot");
  const byok = details.find((row) => row.billing_source === "external");
  assert.equal(copilot.calls, 2);
  assert.equal(copilot.aiu, 2);
  assert.equal(byok.calls, 1);
  assert.equal(byok.provider, "azure_openai");
  assert.equal(byok.aiu, null);
  assert.equal(byok.unpriced_calls, 1);

  const calls = (await get("/api/calls?id=parent")).rows;
  assert.equal(calls.length, 3);
  assert.equal(calls.find((row) => row.billing_source === "external").aiu, null);
  const from = "2026-10-23T00:00:00.000Z", to = "2026-10-24T00:00:00.000Z";
  const totals = (await get(`/api/totals?c=${encodeURIComponent(from + "|" + to)}`)).rows[0];
  const window = await get(`/api/window?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucket=day`);
  assert.equal(totals.calls, 4);
  assert.equal(totals.aiu, 2);
  assert.equal(totals.external_calls, 2);
  assert.equal(totals.unpriced_calls, 2);
  assert.equal(window.models.reduce((sum, row) => sum + row.calls, 0), totals.calls);
  assert.equal(window.models.reduce((sum, row) => sum + (row.aiu ?? 0), 0), totals.aiu);
  assert.equal(window.top.find((row) => row.id === "child").unpriced_calls, 1);
  assert.equal(reads.length, 2);

  const html = await (await fetch(running.url)).text();
  assert.match(html, /External provider charges are not included/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
});

test("serves log-only usage and reports the absent legacy table", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-costs-server-test-"));
  const state = join(root, "session-state", "session");
  mkdirSync(state, { recursive: true });
  const store = new DatabaseSync(join(root, "session-store.db"));
  const app = new DatabaseSync(join(root, "data.db"));
  let costs, running;
  t.after(async () => {
    if (running) await new Promise((resolve) => running.server.close(resolve));
    if (costs) costs.close();
    store.close();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.exec("CREATE TABLE sessions (id TEXT, summary TEXT, repository TEXT)");
  app.exec("CREATE TABLE sessions (id TEXT, title TEXT); CREATE TABLE workspaces (session_id TEXT, creator_session_id TEXT)");
  writeFileSync(join(state, "events.jsonl"), JSON.stringify({
    type: "session.usage_record",
    timestamp: "2026-10-23T12:00:00.000Z",
    data: { usage: {
      model: "external-model", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
      isByok: true, accounting: { sourceSessionId: "session", usageId: "call" },
    } },
  }) + "\n");
  let update = null;
  costs = createSessionCosts({
    root,
    updates: { check: async () => ({ currentVersion: "0.1.0", update, error: null }) },
  });
  running = await costs.start();
  const postUpgrade = () => fetch(new URL("/api/upgrade", running.url), {
    method: "POST", headers: { Origin: new URL(running.url).origin, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal((await postUpgrade()).status, 409);
  update = { version: "0.2.0" };
  const updateStatus = await (await fetch(new URL("/api/update", running.url))).json();
  assert.equal(updateStatus.canUpgrade, false);
  assert.equal((await postUpgrade()).status, 409);
  const response = await fetch(new URL("/api/session?id=session", running.url));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.rows[0].calls, 1);
  assert.equal(data.rows[0].billing_source, "external");
  assert.equal(data.rows[0].aiu, null);
  assert.match(data.warnings.join(" "), /Legacy usage table is missing/);
});
