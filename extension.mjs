import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const AIU_USD = 0.01;
const dir = new URL(".", import.meta.url);
const db = new DatabaseSync(`${homedir()}/.copilot/session-store.db`, { readOnly: true });

const appDb = new DatabaseSync(`${homedir()}/.copilot/data.db`, { readOnly: true });
const sessions = () => {
  const usage = db.prepare(`
    SELECT session_id id, count(*) calls, sum(total_nano_aiu)/1e9 aiu, max(created_at) last_at
    FROM assistant_usage_events GROUP BY session_id`).all();
  const titles = new Map(appDb.prepare(`SELECT id, title FROM sessions`).all().map((r) => [r.id, r.title]));
  const summaries = new Map(db.prepare(`SELECT id, summary, repository FROM sessions`).all().map((r) => [r.id, r]));
  const parents = new Map(appDb.prepare(
    `SELECT session_id id, creator_session_id parent FROM workspaces WHERE session_id IS NOT NULL AND creator_session_id IS NOT NULL AND creator_session_id != session_id`).all().map((r) => [r.id, r.parent]));
  const rows = new Map(usage.map((r) => [r.id, r]));
  for (const r of [...rows.values()]) {
    for (let p = parents.get(r.id); p && !rows.has(p); p = parents.get(p)) rows.set(p, { id: p, calls: 0, aiu: 0, last_at: null });
  }
  return [...rows.values()].map((r) => ({
    ...r,
    name: titles.get(r.id) ?? summaries.get(r.id)?.summary ?? "(untitled)",
    repo: summaries.get(r.id)?.repository ?? null,
    parent: parents.get(r.id) ?? null,
  }));
};
const detail = (id) => db.prepare(`
  SELECT model, count(*) calls, COALESCE(sum(input_tokens),0) inp, COALESCE(sum(output_tokens),0) outp,
    COALESCE(sum(cache_read_tokens),0) cr, COALESCE(sum(cache_write_tokens),0) cw, COALESCE(sum(total_nano_aiu),0)/1e9 aiu,
    min(created_at) first_at, max(created_at) last_at
  FROM assistant_usage_events WHERE session_id = ? GROUP BY model`).all(id);
const calls = (id) => db.prepare(`
  SELECT created_at t, model, COALESCE(input_tokens,0) inp, COALESCE(output_tokens,0) outp, COALESCE(total_nano_aiu,0)/1e9 aiu, COALESCE(duration_ms,0) ms
  FROM assistant_usage_events WHERE session_id = ? ORDER BY created_at DESC LIMIT 500`).all(id);

const totals = (ranges) => ranges.map((r) => {
  const [from, to = "9999"] = r.split("|");
  return db.prepare(
    `SELECT count(*) calls, COALESCE(sum(total_nano_aiu),0)/1e9 aiu FROM assistant_usage_events WHERE created_at >= ? AND created_at < ?`).get(from, to);
});

const windowStats = (from, to, bucket) => {
  const fmt = bucket === "day" ? "%Y-%m-%d" : "%Y-%m-%d %H:00";
  const w = "created_at >= ? AND created_at < ?";
  const models = db.prepare(`
    SELECT model, count(*) calls, COALESCE(sum(input_tokens),0) inp, COALESCE(sum(output_tokens),0) outp, COALESCE(sum(cache_read_tokens),0) cr,
      COALESCE(sum(cache_write_tokens),0) cw, COALESCE(sum(total_nano_aiu),0)/1e9 aiu FROM assistant_usage_events WHERE ${w}
    GROUP BY model ORDER BY aiu DESC`).all(from, to);
  const buckets = db.prepare(`
    SELECT strftime('${fmt}', created_at, 'localtime') b, model, COALESCE(sum(total_nano_aiu),0)/1e9 aiu
    FROM assistant_usage_events WHERE ${w} GROUP BY b, model ORDER BY b`).all(from, to);
  const names = new Map(sessions().map((r) => [r.id, r.name]));
  const top = db.prepare(`
    SELECT session_id id, count(*) calls, COALESCE(sum(total_nano_aiu),0)/1e9 aiu FROM assistant_usage_events WHERE ${w}
    GROUP BY session_id ORDER BY aiu DESC LIMIT 8`).all(from, to).map((r) => ({ ...r, name: names.get(r.id) ?? r.id }));
  return { models, buckets, top };
};

const servers = new Map();
async function start() {
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (rows) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ rate: AIU_USD, rows })); };
    const id = u.searchParams.get("id") ?? "";
    if (u.pathname === "/api/window") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ rate: AIU_USD, ...windowStats(u.searchParams.get("from"), u.searchParams.get("to") ?? "9999", u.searchParams.get("bucket")) }));
    }
    if (u.pathname === "/api/totals") return json(totals(u.searchParams.getAll("c")));
    if (u.pathname === "/api/sessions") return json(sessions());
    if (u.pathname === "/api/session") return json(detail(id));
    if (u.pathname === "/api/calls") return json(calls(id));
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(readFileSync(new URL("index.html", dir), "utf8"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

await joinSession({
  canvases: [createCanvas({
    id: "session-costs",
    displayName: "Session costs",
    description: "Lists Copilot sessions; pick one to see its cost, rate of change and recent calls.",
    open: async (ctx) => {
      let e = servers.get(ctx.instanceId);
      if (!e) { e = await start(); servers.set(ctx.instanceId, e); }
      return { title: "Session costs", url: e.url };
    },
    onClose: async (ctx) => {
      const e = servers.get(ctx.instanceId);
      if (e) { servers.delete(ctx.instanceId); await new Promise((r) => e.server.close(() => r())); }
    },
  })],
});
