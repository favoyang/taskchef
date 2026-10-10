import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import * as zlib from "node:zlib";
import { estimateCallCost } from "./codex-pricing.js";

const FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const zero = () => Object.fromEntries(FIELDS.map(key => [key, 0]));
function usage(value) {
  if (!value || !["input_tokens", "output_tokens", "total_tokens"].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  const result = Object.fromEntries(FIELDS.map(key => [key, value[key] ?? 0]));
  return FIELDS.every(key => Number.isSafeInteger(result[key]) && result[key] >= 0) ? result : null;
}
function add(target, value) { for (const key of FIELDS) target[key] += value[key]; }
const bucket = () => ({ tokens: zero(), costUsd: 0, partial: false, costPartial: false, samples: 0 });

// Cumulative totals and call counters are independent. A missing boundary can
// leave one turn partial without preventing later calls from being allocated.
export function summarizeRecords(records, latestTurnId, models, child = false) {
  const total = bucket(), latest = bucket(), durations = new Map(), seen = new Set();
  let previous = zero();
  for (const record of [...records].sort((a, b) => a.time - b.time || a.order - b.order)) {
    const key = JSON.stringify([record.time, record.kind, record.turn, record.root, record.model, record.total, record.last, record.duration]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (record.kind === "duration") {
      if (Number.isFinite(record.duration) && record.duration >= 0 && record.turn) durations.set(record.turn, record.duration);
      continue;
    }
    if (record.kind === "issue") {
      total.partial = total.costPartial = true;
      if ((child ? record.root : record.turn) === latestTurnId || !(child ? record.root : record.turn)) latest.partial = latest.costPartial = true;
      continue;
    }
    const current = usage(record.total), last = usage(record.last);
    if (!current) {
      total.partial = total.costPartial = true;
      if ((child ? record.root : record.turn) === latestTurnId || !(child ? record.root : record.turn)) latest.partial = latest.costPartial = true;
      continue;
    }
    const delta = Object.fromEntries(FIELDS.map(key => [key, current[key] - previous[key]]));
    if (FIELDS.every(key => delta[key] === 0)) continue; // Repeated rate-limit event.
    const reset = FIELDS.some(key => delta[key] < 0);
    previous = current;
    if (!last) {
      if (!reset) { add(total.tokens, delta); total.samples++; }
      total.partial = total.costPartial = true;
      if ((child ? record.root : record.turn) === latestTurnId || !(child ? record.root : record.turn)) latest.partial = latest.costPartial = true;
      continue;
    }
    const captured = reset ? last : delta;
    const complete = !reset && FIELDS.every(key => captured[key] === last[key]);
    add(total.tokens, captured); total.samples++;
    const price = estimateCallCost(last, record.model, models);
    total.costUsd += price ?? 0;
    total.costPartial ||= !complete || price == null;
    total.partial ||= reset;
    const belongs = (child ? record.root : record.turn) === latestTurnId;
    if (belongs) {
      add(latest.tokens, last); latest.samples++;
      latest.costUsd += price ?? 0;
      latest.partial ||= !complete;
      latest.costPartial ||= !complete || price == null;
    } else if (!(child ? record.root : record.turn)) {
      latest.partial = latest.costPartial = true;
    }
  }
  return { total, latest, durations };
}

async function inventory(root, paths = []) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return paths; throw error; }
  for (const entry of entries) {
    if (entry.isDirectory()) await inventory(join(root, entry.name), paths);
    else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) paths.push(join(root, entry.name));
  }
  return paths;
}

export class CodexSessionUsage {
  constructor({ codexHome, now = Date.now, pricing }) {
    this.home = codexHome; this.now = now; this.pricing = pricing;
    this.files = new Map(); this.paths = []; this.inventoryAt = -Infinity;
    this.pending = Promise.resolve();
    this.results = new Map();
  }
  read(options) {
    // Concurrent views share parsing work. No long SQLite transaction is held.
    const result = this.pending.then(() => this.readOnce(options));
    this.pending = result.catch(() => {});
    return result;
  }
  async readOnce({ id, latestTurnId, sessions, savedDurations = [] }) {
    let inventoryFailed = false;
    if (this.now() - this.inventoryAt >= 60_000) {
      try {
        this.paths = [...await inventory(join(this.home, "sessions")), ...await inventory(join(this.home, "archived_sessions"))];
        this.inventoryAt = this.now();
      } catch { inventoryFailed = true; }
    }
    const parsed = [];
    for (const session of sessions) {
      const paths = new Set(this.paths.filter(path => basename(path).includes(`-${session.id}`)));
      if (session.rollout_path) paths.add(session.rollout_path);
      const records = [], versions = [];
      let failed = inventoryFailed, latestFailed = false, timePartial = inventoryFailed;
      if (!paths.size) failed = latestFailed = timePartial = true;
      for (const path of paths) {
        try {
          const file = await this.readFile(path, session.id);
          for (const record of file.records) records.push(record);
          versions.push([path, file.identity, file.size, file.mtime]);
          timePartial ||= file.partial;
        } catch {
          failed = timePartial = true;
          latestFailed ||= session.id !== id || path === session.rollout_path;
          versions.push([path, "missing"]);
        }
      }
      parsed.push({ session, records, versions, failed, latestFailed, timePartial });
    }
    const pricing = await this.pricing.get({ refresh: parsed.some(entry => entry.records.some(record => record.kind === "usage")) });
    const signature = JSON.stringify([latestTurnId, savedDurations, parsed.map(entry => [entry.session.id, entry.versions, entry.failed, entry.timePartial]), pricing]);
    const cached = this.results.get(id);
    if (cached?.signature === signature) return cached.result;
    const result = { latest: bucket(), total: bucket(), subagents: sessions.length - 1, pricingDate: pricing.date,
      durationMs: 0, durationTurns: 0, partial: inventoryFailed };
    for (const { session, records, failed, latestFailed, timePartial } of parsed) {
      const summary = summarizeRecords(records, latestTurnId, pricing.models, session.id !== id);
      for (const key of ["total", "latest"]) {
        add(result[key].tokens, summary[key].tokens);
        result[key].costUsd += summary[key].costUsd;
        result[key].samples += summary[key].samples;
        const missing = key === "total" ? failed || summary.total.samples === 0 : latestFailed;
        result[key].partial ||= missing || summary[key].partial;
        result[key].costPartial ||= missing || summary[key].costPartial;
      }
      if (session.id === id) result.partial ||= timePartial;
      if (session.id === id) {
        for (const saved of savedDurations) {
          if (Number.isFinite(saved.duration_ms) && saved.duration_ms >= 0 && !summary.durations.has(saved.turn_id)) summary.durations.set(saved.turn_id, saved.duration_ms);
        }
        result.durationMs = [...summary.durations.values()].reduce((sum, value) => sum + value, 0);
        result.durationTurns = summary.durations.size;
      }
    }
    this.results.set(id, { signature, result });
    return result;
  }
  async readFile(path, expectedId) {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error("Rollout is empty or not a file.");
    let cached = this.files.get(path);
    if (cached && cached.identity === `${info.dev}:${info.ino}` && cached.size === info.size && cached.mtime === info.mtimeMs) return cached;
    const compressed = path.endsWith(".zst");
    if (!cached || compressed || cached.identity !== `${info.dev}:${info.ino}` || info.size < cached.size || info.size === cached.size) {
      cached = { identity: `${info.dev}:${info.ino}`, offset: 0, records: [], partial: false, turn: null, root: null, model: null, valid: false };
    }
    let pending = Buffer.alloc(0), consumed = cached.offset, skipping = false;
    for await (const chunk of readChunks(path, { start: cached.offset, end: info.size - 1, highWaterMark: 256 * 1024 }, compressed)) {
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, end);
        consumed += end + 1;
        if (!skipping) this.line(cached, line, expectedId);
        skipping = false;
        pending = pending.subarray(end + 1);
        cached.offset = consumed;
      }
      if (pending.length > 2 * 1024 * 1024) {
        // Image/message bodies can be huge; accounting records are small.
        if (/"type"\s*:\s*"(?:turn_context|session_meta|token_count)"/.test(pending.subarray(0, 256).toString())) this.issue(cached);
        consumed += pending.length; pending = Buffer.alloc(0); skipping = true;
      }
    }
    cached.size = info.size; cached.mtime = info.mtimeMs;
    if (!cached.valid) throw new Error("Rollout belongs to a different chat.");
    this.files.set(path, cached);
    return cached;
  }
  line(file, buffer, expectedId) {
    let row;
    try { row = JSON.parse(buffer.toString("utf8")); } catch { this.issue(file); return; }
    const p = row.payload;
    if (row.type === "session_meta") { file.valid = p?.id === expectedId; return; }
    if (!file.valid || !p) return;
    if (row.type === "turn_context") { file.turn = p.turn_id; file.root = p.root_turn_id; file.model = p.model; return; }
    if (row.type !== "event_msg") return;
    if (p.type === "task_started") { file.turn = p.turn_id; file.root = p.root_turn_id ?? file.root; }
    const time = Date.parse(row.timestamp);
    if (!Number.isFinite(time)) { file.partial = true; return; }
    if (p.type === "token_count" && p.info) file.records.push({ kind: "usage", time, order: file.offset,
      turn: file.turn, root: file.root, model: file.model, total: p.info.total_token_usage, last: p.info.last_token_usage });
    if (["task_complete", "turn_aborted"].includes(p.type)) {
      const duration = p.duration_ms ?? (Date.parse(p.completed_at) - Date.parse(p.started_at));
      if (!Number.isFinite(duration) || duration < 0) file.partial = true;
      file.records.push({ kind: "duration", time, order: file.offset, turn: p.turn_id ?? file.turn, duration });
    }
  }
  issue(file) {
    file.partial = true;
    file.records.push({ kind: "issue", time: 0, order: file.offset, turn: file.turn, root: file.root });
  }
}

async function* readChunks(path, options, compressed) {
  if (compressed && typeof zlib.createZstdDecompress !== "function") throw new Error("This runtime cannot decode compressed rollouts.");
  const input = createReadStream(path, options);
  const stream = compressed ? zlib.createZstdDecompress() : input;
  if (compressed) { input.on("error", error => stream.destroy(error)); input.pipe(stream); }
  try { for await (const chunk of stream) yield chunk; }
  finally { input.destroy(); if (compressed) stream.destroy(); }
}
