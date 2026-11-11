import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MATCH_SKEW_MS = 10;

const text = (value) => typeof value === "string" && value ? value : null;
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const counter = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const timestamp = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? { value: new Date(ms).toISOString(), ms } : { value: null, ms: null };
};
const version = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

function isAncestor(ancestor, child, parents) {
  const seen = new Set();
  for (let id = parents.get(child); id && !seen.has(id); id = parents.get(id)) {
    if (id === ancestor) return true;
    seen.add(id);
  }
  return false;
}

function preferred(left, right, parents) {
  const leftIsSource = left.fileSession === left.sourceSession;
  const rightIsSource = right.fileSession === right.sourceSession;
  if (leftIsSource !== rightIsSource) return leftIsSource ? left : right;
  if (isAncestor(left.fileSession, right.fileSession, parents)) return left;
  if (isAncestor(right.fileSession, left.fileSession, parents)) return right;
  return left.fileSession.localeCompare(right.fileSession) <= 0 ? left : right;
}

function fingerprint(sessionId, record) {
  return JSON.stringify([
    sessionId, record.model, record.input, record.output, record.cacheRead, record.cacheWrite,
  ]);
}

function compatible(left, right) {
  return ["duration", "reasoning", "endpoint", "initiator", "finish", "aiu"]
    .every((key) => left[key] == null || right[key] == null || left[key] === right[key]);
}

function signature(record) {
  return JSON.stringify([
    record.timestamp, record.model, record.input, record.output, record.cacheRead, record.cacheWrite,
    record.duration, record.reasoning, record.endpoint, record.initiator, record.finish, record.aiu,
    record.billingSource, record.provider, record.displayName,
  ]);
}

function legacyCandidates(records, logged) {
  if (logged.timestampMs == null) return [];
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (records[middle].timestampMs < logged.timestampMs - MATCH_SKEW_MS) low = middle + 1;
    else high = middle;
  }
  const candidates = [];
  for (let i = low; i < records.length && records[i].timestampMs <= logged.timestampMs + MATCH_SKEW_MS; i++) {
    if (compatible(records[i], logged)) candidates.push(records[i]);
  }
  return candidates.sort((a, b) =>
    Math.abs(a.timestampMs - logged.timestampMs) - Math.abs(b.timestampMs - logged.timestampMs));
}

function matchLegacy(nodes, legacyCount) {
  const owners = new Map();
  for (const start of nodes) {
    if (owners.size === legacyCount) break;
    const queue = [start];
    const visited = new Set(queue);
    const paths = new Map();
    let free = null;
    for (let i = 0; i < queue.length && !free; i++) {
      for (const candidate of queue[i].candidates) {
        if (paths.has(candidate.index)) continue;
        paths.set(candidate.index, queue[i]);
        const owner = owners.get(candidate.index);
        if (!owner) {
          free = candidate;
          break;
        }
        if (!visited.has(owner)) {
          visited.add(owner);
          queue.push(owner);
        }
      }
    }
    while (free) {
      const node = paths.get(free.index);
      const previous = node.match;
      owners.set(free.index, node);
      node.match = free;
      free = previous;
    }
  }
}

function parseLog(contents, sessionId) {
  const records = [];
  let malformed = 0;
  let invalid = 0;
  let unidentifiable = 0;
  let unattributed = 0;
  const lines = contents.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!event || typeof event !== "object" || event.type !== "session.usage_record") continue;
    const usage = event.data?.usage;
    if (!usage || typeof usage !== "object") {
      invalid++;
      continue;
    }
    const time = timestamp(event.timestamp);
    const model = text(usage.model);
    const input = counter(usage.inputTokens);
    const output = counter(usage.outputTokens);
    const cacheRead = counter(usage.cacheReadTokens);
    const cacheWrite = counter(usage.cacheWriteTokens);
    const duration = number(usage.duration);
    const reasoning = counter(usage.reasoningTokens);
    const aiu = number(usage.copilotUsage?.totalNanoAiu);
    if (!time.value || !model || [input, output, cacheRead, cacheWrite].includes(null) ||
        (usage.duration != null && duration == null) ||
        (usage.reasoningTokens != null && reasoning == null) ||
        (usage.copilotUsage?.totalNanoAiu != null && aiu == null)) invalid++;
    const billingSource = usage.isByok === true ? "external" : usage.isByok === false ? "copilot" : "unknown";
    const accounting = usage.accounting && typeof usage.accounting === "object" ? usage.accounting : {};
    const usageId = text(accounting.usageId) ?? text(usage.apiCallId);
    const sourceSession = text(accounting.sourceSessionId);
    if (!usageId) unidentifiable++;
    else if (!sourceSession) unattributed++;
    records.push({
      fileSession: sessionId,
      sourceSession: sourceSession ?? sessionId,
      usageId,
      line: index,
      timestamp: time.value,
      timestampMs: time.ms,
      model,
      input,
      output,
      cacheRead,
      cacheWrite,
      duration,
      reasoning,
      endpoint: text(usage.apiEndpoint),
      initiator: text(usage.initiator),
      finish: text(usage.finishReason),
      aiu,
      billingSource,
      provider: billingSource === "external" ? text(usage.modelProvider) ?? text(usage.providerType) : null,
      displayName: billingSource === "external" ? text(usage.modelDisplayName) : null,
    });
  }
  const warnings = [];
  if (malformed) warnings.push(`${sessionId}: ${malformed} malformed JSONL line${malformed === 1 ? "" : "s"}`);
  if (invalid) warnings.push(`${sessionId}: ${invalid} usage event${invalid === 1 ? "" : "s"} with missing or invalid fields`);
  if (unidentifiable) warnings.push(`${sessionId}: ${unidentifiable} usage event${unidentifiable === 1 ? "" : "s"} without a stable ID cannot be deduplicated across sessions`);
  if (unattributed) warnings.push(`${sessionId}: ${unattributed} usage event${unattributed === 1 ? "" : "s"} without an accounting source may not be deduplicated across sessions`);
  return { records, warnings };
}

export class UsageStore {
  constructor({ root, store, getParents = () => new Map(), readLog = (file) => readFileSync(file, "utf8") }) {
    this.root = root;
    this.store = store;
    this.getParents = getParents;
    this.readLog = readLog;
    this.snapshots = new Map();
    this.legacy = [];
    this.legacyWarnings = [];
    this.mergeWarnings = [];
    this.warnings = [];
    this.dataVersion = null;
    this.parentsVersion = null;
    this.db = new DatabaseSync(":memory:");
    this.db.exec(`
      CREATE TABLE assistant_usage_events (
        session_id TEXT NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER, total_nano_aiu INTEGER,
        duration_ms INTEGER, created_at TEXT, billing_source TEXT NOT NULL, provider TEXT, model_display_name TEXT
      );
      CREATE INDEX ix_session ON assistant_usage_events(session_id);
      CREATE INDEX ix_created_at ON assistant_usage_events(created_at);
    `);
    this.insert = this.db.prepare("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    this.selectLegacy = this.prepareLegacy();
    this.selectDataVersion = store.prepare("PRAGMA data_version");
  }

  prepareLegacy() {
    const columns = new Set(this.store.prepare("PRAGMA table_info(assistant_usage_events)").all().map((row) => row.name));
    if (!columns.size) return null;
    const required = ["session_id", "model", "input_tokens", "output_tokens", "cache_read_tokens",
      "cache_write_tokens", "total_nano_aiu", "created_at"];
    const missing = required.filter((name) => !columns.has(name));
    if (missing.length) throw new Error(`assistant_usage_events is missing columns: ${missing.join(", ")}`);
    const optional = ["duration_ms", "reasoning_tokens", "api_endpoint", "initiator", "finish_reason"];
    const selected = optional.map((name) => columns.has(name) ? name : `NULL AS ${name}`);
    return this.store.prepare(`SELECT ${[...required, ...selected].join(", ")} FROM assistant_usage_events`);
  }

  readLegacy() {
    if (!this.selectLegacy) this.selectLegacy = this.prepareLegacy();
    if (!this.selectLegacy) {
      this.legacy = [];
      this.legacyWarnings = ["Legacy usage table is missing; showing session logs only"];
      return;
    }
    let invalid = 0;
    this.legacy = this.selectLegacy.all().map((row, index) => {
      const time = timestamp(row.created_at);
      const record = {
        index,
        fileSession: row.session_id,
        timestamp: time.value,
        timestampMs: time.ms,
        model: text(row.model),
        input: counter(row.input_tokens),
        output: counter(row.output_tokens),
        cacheRead: counter(row.cache_read_tokens),
        cacheWrite: counter(row.cache_write_tokens),
        duration: number(row.duration_ms),
        reasoning: counter(row.reasoning_tokens),
        endpoint: text(row.api_endpoint),
        initiator: text(row.initiator),
        finish: text(row.finish_reason),
        aiu: number(row.total_nano_aiu),
        billingSource: "unknown",
        provider: null,
        displayName: null,
      };
      if (!record.timestamp || !record.model ||
          [record.input, record.output, record.cacheRead, record.cacheWrite].includes(null) ||
          (row.total_nano_aiu != null && record.aiu == null)) invalid++;
      return record;
    });
    this.legacyWarnings = invalid ? [`Legacy store: ${invalid} usage event${invalid === 1 ? "" : "s"} with missing or invalid fields`] : [];
  }

  refresh() {
    let changed = false;
    const scanWarnings = [];
    const dataVersion = this.selectDataVersion.get().data_version;
    if (this.dataVersion !== dataVersion) {
      this.readLegacy();
      this.dataVersion = dataVersion;
      changed = true;
    }

    const state = join(this.root, "session-state");
    let directories;
    try {
      directories = readdirSync(state, { withFileTypes: true });
    } catch (error) {
      scanWarnings.push(`Cannot scan session logs: ${error.message}`);
    }
    if (directories) {
      const visited = new Set();
      for (const directory of directories) {
        if (!directory.isDirectory()) continue;
        const id = directory.name;
        visited.add(id);
        const file = join(state, id, "events.jsonl");
        let before;
        try {
          before = statSync(file, { bigint: true });
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") {
            if (this.snapshots.delete(id)) changed = true;
          } else {
            scanWarnings.push(`Cannot inspect ${id} session log: ${error.message}`);
          }
          continue;
        }
        const previous = this.snapshots.get(id);
        const beforeVersion = version(before);
        if (previous?.version === beforeVersion) continue;
        try {
          const contents = this.readLog(file);
          const after = statSync(file, { bigint: true });
          const parsed = parseLog(contents, id);
          this.snapshots.set(id, { ...parsed, version: version(after) === beforeVersion ? beforeVersion : null });
          changed = true;
        } catch (error) {
          scanWarnings.push(`Cannot read ${id} session log${previous ? " (using last successful read)" : ""}: ${error.message}`);
        }
      }
      for (const id of this.snapshots.keys()) {
        if (!visited.has(id)) {
          this.snapshots.delete(id);
          changed = true;
        }
      }
    }

    const parents = this.getParents();
    const parentsVersion = JSON.stringify([...parents].sort(([a], [b]) => a.localeCompare(b)));
    if (changed || parentsVersion !== this.parentsVersion) {
      this.rebuild(parents);
      this.parentsVersion = parentsVersion;
    }
    this.warnings = [
      ...this.legacyWarnings,
      ...scanWarnings,
      ...[...this.snapshots.values()].flatMap((snapshot) => snapshot.warnings),
      ...this.mergeWarnings,
    ];
  }

  rebuild(parents) {
    const groups = new Map();
    for (const [sessionId, snapshot] of this.snapshots) {
      for (const record of snapshot.records) {
        const key = record.usageId
          ? JSON.stringify(["usage", record.sourceSession, record.usageId])
          : JSON.stringify(["line", sessionId, record.line]);
        const group = groups.get(key) ?? [];
        group.push(record);
        groups.set(key, group);
      }
    }

    let conflicts = 0;
    const unique = [...groups.values()].map((records) => {
      const record = records.reduce((best, candidate) => preferred(best, candidate, parents));
      if (records.some((candidate) => signature(candidate) !== signature(record))) conflicts++;
      return {
        record, records, matches: [],
        sessions: new Set([record.sourceSession, ...records.map((candidate) => candidate.fileSession)]),
      };
    }).sort((a, b) => (a.record.timestampMs ?? Infinity) - (b.record.timestampMs ?? Infinity));

    const legacyByFingerprint = new Map();
    for (const record of this.legacy) {
      if (record.timestampMs == null) continue;
      const key = fingerprint(record.fileSession, record);
      const matches = legacyByFingerprint.get(key) ?? [];
      matches.push(record);
      legacyByFingerprint.set(key, matches);
    }
    for (const records of legacyByFingerprint.values()) records.sort((a, b) => a.timestampMs - b.timestampMs);
    const candidatesByFingerprint = new Map();
    for (const group of unique) {
      for (const sessionId of group.sessions) {
        const logged = group.records.find((candidate) => candidate.fileSession === sessionId) ?? group.record;
        const key = fingerprint(sessionId, logged);
        const legacy = legacyByFingerprint.get(key);
        if (!legacy) continue;
        const candidates = legacyCandidates(legacy, logged);
        if (!candidates.length) continue;
        const nodes = candidatesByFingerprint.get(key) ?? [];
        nodes.push({ group, candidates, match: null });
        candidatesByFingerprint.set(key, nodes);
      }
    }
    const used = new Set();
    for (const [key, nodes] of candidatesByFingerprint) {
      matchLegacy(nodes, legacyByFingerprint.get(key).length);
      for (const node of nodes) {
        if (node.match) {
          used.add(node.match.index);
          node.group.matches.push(node.match);
        }
      }
    }
    const merged = [];
    for (const { record, matches } of unique) {
      const reportedCosts = new Set(matches.map((candidate) => candidate.aiu).filter((aiu) => aiu != null));
      if (reportedCosts.size > 1) conflicts++;
      merged.push({
        ...record,
        fileSession: matches.some((candidate) => candidate.fileSession === record.sourceSession) ? record.sourceSession : record.fileSession,
        aiu: record.billingSource === "external" ? record.aiu : record.aiu ?? matches.find((candidate) => candidate.aiu != null)?.aiu ?? null,
      });
    }
    this.mergeWarnings = conflicts ? [`${conflicts} duplicate usage identit${conflicts === 1 ? "y has" : "ies have"} conflicting data`] : [];
    merged.push(...this.legacy.filter((record) => !used.has(record.index)));

    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM assistant_usage_events");
      for (const record of merged) {
        this.insert.run(record.fileSession, record.model, record.input, record.output, record.cacheRead,
          record.cacheWrite, record.aiu, record.duration, record.timestamp, record.billingSource,
          record.provider, record.displayName);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}
