import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { UsageStore } from "./usage.mjs";
import { createUpdateChecker } from "./updates.mjs";

const AIU_USD = 0.01;
const dir = new URL(".", import.meta.url);

export function createSessionCosts({ root = `${homedir()}/.copilot`, readLog, updates = createUpdateChecker() } = {}) {
  const store = new DatabaseSync(`${root}/session-store.db`, { readOnly: true });
  const appDb = new DatabaseSync(`${root}/data.db`, { readOnly: true });
  const selectParents = appDb.prepare(
    `SELECT session_id id, creator_session_id parent FROM workspaces WHERE session_id IS NOT NULL AND creator_session_id IS NOT NULL AND creator_session_id != session_id`);
  const getParents = () => new Map(selectParents.all().map((row) => [row.id, row.parent]));
  const usage = new UsageStore({ root, store, getParents, readLog });
  usage.refresh();
  const db = usage.db;

  const sessions = () => {
    const records = db.prepare(`
      SELECT session_id id, count(*) calls, COALESCE(sum(total_nano_aiu),0)/1e9 aiu,
        sum(billing_source = 'external') external_calls, sum(total_nano_aiu IS NULL) unpriced_calls, max(created_at) last_at
      FROM assistant_usage_events GROUP BY session_id`).all();
    const titles = new Map(appDb.prepare("SELECT id, title FROM sessions").all().map((row) => [row.id, row.title]));
    const summaries = new Map(store.prepare("SELECT id, summary, repository FROM sessions").all().map((row) => [row.id, row]));
    const parents = getParents();
    const rows = new Map(records.map((row) => [row.id, row]));
    for (const row of [...rows.values()]) {
      for (let parent = parents.get(row.id); parent && !rows.has(parent); parent = parents.get(parent)) {
        rows.set(parent, { id: parent, calls: 0, aiu: 0, external_calls: 0, unpriced_calls: 0, last_at: null });
      }
    }
    return [...rows.values()].map((row) => ({
      ...row,
      name: titles.get(row.id) ?? summaries.get(row.id)?.summary ?? "(untitled)",
      repo: summaries.get(row.id)?.repository ?? null,
      parent: parents.get(row.id) ?? null,
    }));
  };
  const detail = (id) => db.prepare(`
    SELECT model, billing_source, provider, model_display_name, count(*) calls,
      COALESCE(sum(input_tokens),0) inp, COALESCE(sum(output_tokens),0) outp,
      COALESCE(sum(cache_read_tokens),0) cr, COALESCE(sum(cache_write_tokens),0) cw,
      sum(total_nano_aiu)/1e9 aiu, sum(total_nano_aiu IS NULL) unpriced_calls,
      min(created_at) first_at, max(created_at) last_at
    FROM assistant_usage_events WHERE session_id = ? GROUP BY model, billing_source, provider, model_display_name`).all(id);
  const calls = (id) => db.prepare(`
    SELECT created_at t, model, billing_source, provider, model_display_name,
      COALESCE(input_tokens,0) inp, COALESCE(output_tokens,0) outp, total_nano_aiu/1e9 aiu, duration_ms ms
    FROM assistant_usage_events WHERE session_id = ? ORDER BY created_at DESC LIMIT 500`).all(id);
  const totals = (ranges) => ranges.map((range) => {
    const [from, to = "9999"] = range.split("|");
    return db.prepare(`
      SELECT count(*) calls, COALESCE(sum(total_nano_aiu),0)/1e9 aiu,
        COALESCE(sum(billing_source = 'external'),0) external_calls,
        COALESCE(sum(total_nano_aiu IS NULL),0) unpriced_calls
      FROM assistant_usage_events WHERE created_at >= ? AND created_at < ?`).get(from, to);
  });
  const windowStats = (from, to, bucket) => {
    const fmt = bucket === "day" ? "%Y-%m-%d" : "%Y-%m-%d %H:00";
    const where = "created_at >= ? AND created_at < ?";
    const models = db.prepare(`
      SELECT model, billing_source, provider, model_display_name, count(*) calls,
        COALESCE(sum(input_tokens),0) inp, COALESCE(sum(output_tokens),0) outp, COALESCE(sum(cache_read_tokens),0) cr,
        COALESCE(sum(cache_write_tokens),0) cw, sum(total_nano_aiu)/1e9 aiu, sum(total_nano_aiu IS NULL) unpriced_calls
      FROM assistant_usage_events WHERE ${where}
      GROUP BY model, billing_source, provider, model_display_name ORDER BY aiu DESC`).all(from, to);
    const buckets = db.prepare(`
      SELECT strftime('${fmt}', created_at, 'localtime') b, model, billing_source, provider, model_display_name,
        COALESCE(sum(total_nano_aiu),0)/1e9 aiu
      FROM assistant_usage_events WHERE ${where} GROUP BY b, model, billing_source, provider, model_display_name ORDER BY b`).all(from, to);
    const names = new Map(sessions().map((row) => [row.id, row.name]));
    const top = db.prepare(`
      SELECT session_id id, count(*) calls, COALESCE(sum(total_nano_aiu),0)/1e9 aiu,
        sum(total_nano_aiu IS NULL) unpriced_calls FROM assistant_usage_events WHERE ${where}
      GROUP BY session_id ORDER BY aiu DESC LIMIT 8`).all(from, to).map((row) => ({ ...row, name: names.get(row.id) ?? row.id }));
    return { models, buckets, top };
  };

  async function start({ requestUpgrade } = {}) {
    let upgradeRequest;
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://x");
        res.setHeader("cache-control", "no-store");
        if (url.pathname === "/api/update") {
          res.setHeader("content-type", "application/json");
          const status = await updates.check();
          return res.end(JSON.stringify({ ...status, canUpgrade: !!requestUpgrade, requested: !!upgradeRequest }));
        }
        if (url.pathname === "/api/upgrade") {
          res.setHeader("content-type", "application/json");
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.setHeader("allow", "POST");
            return res.end(JSON.stringify({ error: "Use POST to request an upgrade" }));
          }
          if (req.headers.origin !== `http://127.0.0.1:${server.address().port}` ||
              req.headers["content-type"] !== "application/json") {
            res.statusCode = 403;
            return res.end(JSON.stringify({ error: "Upgrade must be requested from this canvas" }));
          }
          const { update, error } = await updates.check();
          if (error || !update || !requestUpgrade) {
            res.statusCode = 409;
            return res.end(JSON.stringify({ error: error ?? "No supported upgrade is available" }));
          }
          if (!upgradeRequest) {
            upgradeRequest = Promise.resolve().then(() => requestUpgrade(update)).catch((error) => {
              upgradeRequest = null;
              throw error;
            });
          }
          await upgradeRequest;
          return res.end(JSON.stringify({ requested: true }));
        }
        if (url.pathname.startsWith("/api/")) usage.refresh();
        const json = (rows) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ rate: AIU_USD, rows, warnings: usage.warnings }));
        };
        const id = url.searchParams.get("id") ?? "";
        if (url.pathname === "/api/window") {
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({
            rate: AIU_USD,
            ...windowStats(url.searchParams.get("from"), url.searchParams.get("to") ?? "9999", url.searchParams.get("bucket")),
            warnings: usage.warnings,
          }));
        }
        if (url.pathname === "/api/totals") return json(totals(url.searchParams.getAll("c")));
        if (url.pathname === "/api/sessions") return json(sessions());
        if (url.pathname === "/api/session") return json(detail(id));
        if (url.pathname === "/api/calls") return json(calls(id));
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(readFileSync(new URL("index.html", dir), "utf8"));
      } catch (error) {
        process.stderr.write(`[session-costs] ${error.stack ?? error}\n`);
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: `Unable to load session usage: ${error.message}` }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
  }

  return {
    start,
    close() { usage.close(); store.close(); appDb.close(); },
  };
}
