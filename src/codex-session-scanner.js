import { homedir } from "node:os";
import { basename, join } from "node:path";
import { open, readdir, stat } from "node:fs/promises";

const FILE_LIMIT = 300;
const HEAD_BYTES = 32 * 1024;
const META_LINE_BYTES = 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const SCAN_INTERVAL_MS = 30_000;
const FULL_INTERVAL_MS = 10 * 60_000;
const ACTIVE_WINDOW_MS = 2 * 60_000;
const SESSION_FILE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i;

async function listFiles(root, archive) {
  const results = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && SESSION_FILE.test(entry.name)) {
        try {
          const info = await stat(path);
          results.push({ path, archive, size: info.size, mtimeMs: info.mtimeMs, id: entry.name.match(SESSION_FILE)[1] });
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  }
  await walk(root);
  return results;
}

function parseLines(text, onRecord) {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    try { onRecord(JSON.parse(line)); }
    catch (error) {
      if (index === lines.length - 1 && !text.endsWith("\n")) continue; // A live append can leave a partial line.
      throw error;
    }
  }
}

async function readSlice(handle, start, bytes) {
  if (bytes <= 0) return "";
  const buffer = Buffer.allocUnsafe(bytes);
  const { bytesRead } = await handle.read(buffer, 0, bytes, start);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

async function readSession(file, now) {
  const handle = await open(file.path, "r");
  try {
    const size = (await handle.stat()).size;
    let headEnd = Math.min(size, HEAD_BYTES);
    let head = await readSlice(handle, 0, headEnd);
    if (!head.includes("\n") && headEnd < size) {
      headEnd = Math.min(size, META_LINE_BYTES);
      head = await readSlice(handle, 0, headEnd);
    }
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const contiguous = tailStart <= headEnd;
    const tail = contiguous ? await readSlice(handle, headEnd, size - headEnd) : await readSlice(handle, tailStart, size - tailStart);
    let cwd = "";
    let createdAt = "";
    let lastEvent = "";
    let lastEventAt = "";
    let userMessages = 0;
    let assistantMessages = 0;
    let hasSessionMeta = false;
    const accept = (record) => {
      const payload = record?.payload;
      if (record?.type === "session_meta") {
        if (payload?.id === file.id && typeof payload.cwd === "string" && payload.cwd) {
          hasSessionMeta = true;
          cwd = payload.cwd;
          createdAt = typeof payload.timestamp === "string" ? payload.timestamp : createdAt;
        }
      }
      if (record?.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(payload?.type)) {
        lastEvent = payload.type;
        lastEventAt = typeof record.timestamp === "string" ? record.timestamp : lastEventAt;
      }
      if (record?.type === "response_item" && payload?.type === "message") {
        if (payload.role === "user") userMessages += 1;
        if (payload.role === "assistant") assistantMessages += 1;
      }
    };
    if (contiguous) parseLines(head + tail, accept);
    else {
      parseLines(head.slice(0, head.lastIndexOf("\n") + 1), accept);
      // A turn event in the unsampled middle could supersede the head event.
      lastEvent = "";
      lastEventAt = "";
      parseLines(tail.slice(tail.indexOf("\n") + 1), accept);
    }
    if (!hasSessionMeta) throw new Error("Session metadata is missing or invalid.");
    const updatedAt = new Date(file.mtimeMs).toISOString();
    const projectName = cwd ? basename(cwd) || cwd : "Unknown project";
    const active = !file.archive && lastEvent === "task_started" && now - file.mtimeMs < ACTIVE_WINDOW_MS;
    const activity = active ? "A turn started recently; live activity is unverified."
      : lastEvent === "task_complete" ? "Latest recorded turn ended; task outcome is unknown."
        : lastEvent === "turn_aborted" ? "Latest recorded turn stopped; task outcome is unknown."
          : "Task outcome is unknown from the available log segment.";
    return {
      id: file.id, title: `Codex chat ${file.id.slice(0, 8)}`, instruction: "Private request text is not shown in this read-only demo.",
      summary: activity, status: active ? "working" : null, createdAt: createdAt || updatedAt, updatedAt,
      updatedBy: "Local Codex log", project: { name: projectName, path: cwd, githubRepos: [] },
      threadId: file.id, turnRef: null, turnId: null, lastResult: null, latestTurn: null,
      observed: { archive: file.archive, lastTurnEvent: lastEvent || null, lastTurnEventAt: lastEventAt || null, recentFileActivity: !file.archive && now - file.mtimeMs < ACTIVE_WINDOW_MS, userMessages, assistantMessages, sampledBytes: Math.min(size, headEnd + TAIL_BYTES), fileBytes: size },
    };
  } finally { await handle.close(); }
}

export class CodexSessionScanner {
  constructor({ codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), now = () => Date.now(), fileLimit = FILE_LIMIT, scanIntervalMs = SCAN_INTERVAL_MS, fullIntervalMs = FULL_INTERVAL_MS } = {}) {
    this.codexHome = codexHome;
    this.now = now;
    this.fileLimit = fileLimit;
    this.scanIntervalMs = scanIntervalMs;
    this.fullIntervalMs = fullIntervalMs;
    this.files = new Map();
    this.tasks = new Map();
    this.lastScanMs = 0;
    this.lastFullMs = 0;
    this.revision = 0;
    this.stats = null;
    this.pending = null;
    this.forcedPending = null;
  }
  async refresh({ force = false } = {}) {
    if (this.pending) {
      if (!force) return this.pending;
      if (!this.forcedPending) {
        this.forcedPending = this.pending.then(() => {
          this.forcedPending = null;
          return this.refresh({ force: true });
        });
      }
      return this.forcedPending;
    }
    const now = this.now();
    if (!force && this.stats && now - this.lastScanMs < this.scanIntervalMs) return this.snapshot();
    this.pending = this.scan(now).finally(() => { this.pending = null; });
    return this.pending;
  }
  async scan(now) {
    const full = !this.stats || now - this.lastFullMs >= this.fullIntervalMs;
    try {
      const discovered = [
        ...await listFiles(join(this.codexHome, "sessions"), false),
        ...await listFiles(join(this.codexHome, "archived_sessions"), true),
      ];
      discovered.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
      const selected = discovered.slice(0, this.fileLimit);
      const previousFiles = this.files;
      const nextFiles = new Map();
      const nextTasks = new Map();
      let parsed = 0;
      let changed = 0;
      let errors = 0;
      for (const file of selected) {
        const prior = previousFiles.get(file.path);
        const reusable = !full && prior?.size === file.size && prior?.mtimeMs === file.mtimeMs && prior?.archive === file.archive;
        let task = reusable ? this.tasks.get(file.path) : null;
        let cachedFile = file;
        let readFailed = false;
        if (!task) {
          try { task = await readSession(file, now); parsed += 1; changed += prior ? 1 : 0; }
          catch { errors += 1; readFailed = true; task = this.tasks.get(file.path); cachedFile = prior; }
        }
        if (task) {
          const recentFileActivity = !readFailed && !file.archive && now - file.mtimeMs < ACTIVE_WINDOW_MS;
          const active = recentFileActivity && task.observed.lastTurnEvent === "task_started";
          task = { ...task, status: active ? "working" : null, summary: active
            ? "A turn started recently; live activity is unverified."
            : task.observed.lastTurnEvent === "task_started" ? "A turn started earlier; current activity and task outcome are unknown."
              : task.observed.lastTurnEvent === "task_complete" ? "Latest recorded turn ended; task outcome is unknown."
                : task.observed.lastTurnEvent === "turn_aborted" ? "Latest recorded turn stopped; task outcome is unknown."
                  : recentFileActivity ? "Recent log file activity observed; current turn and task outcome are unknown."
                    : "Task outcome is unknown from the available log segment.",
            observed: { ...task.observed, recentFileActivity } };
          if (cachedFile) nextFiles.set(file.path, cachedFile);
          nextTasks.set(file.path, task);
        }
      }
      const previousIds = [...this.tasks.values()].map((task) => `${task.id}:${task.updatedAt}:${task.status}:${task.observed.archive}:${task.observed.lastTurnEvent}:${task.observed.recentFileActivity}`).join("|");
      const currentIds = [...nextTasks.values()].map((task) => `${task.id}:${task.updatedAt}:${task.status}:${task.observed.archive}:${task.observed.lastTurnEvent}:${task.observed.recentFileActivity}`).join("|");
      if (previousIds !== currentIds || !this.stats) this.revision += 1;
      this.files = nextFiles;
      this.tasks = nextTasks;
      this.lastScanMs = now;
      if (full) this.lastFullMs = now;
      this.stats = {
        mode: full ? "full" : "incremental", checkedAt: new Date(now).toISOString(), intervalSeconds: this.scanIntervalMs / 1000,
        fullIntervalSeconds: this.fullIntervalMs / 1000, indexedFiles: discovered.length, activeFiles: discovered.filter((item) => !item.archive).length,
        archivedFiles: discovered.filter((item) => item.archive).length, parsedFiles: parsed, changedFiles: changed,
        visibleFiles: nextTasks.size, fileLimit: this.fileLimit, unreadFiles: Math.max(0, discovered.length - selected.length), errors,
        sources: ["sessions/**/*.jsonl", "archived_sessions/**/*.jsonl"],
        fields: ["session ID", "timestamps", "project directory", "archive location", "turn events", "message counts", "file size"],
      };
      return this.snapshot();
    } catch (error) {
      this.stats = { ...this.stats, mode: "error", checkedAt: new Date(now).toISOString(), error: String(error) };
      this.lastScanMs = now;
      return this.snapshot(false);
    }
  }
  snapshot(healthy = this.stats?.mode !== "error") {
    return { healthy, revision: this.revision, tasks: [...this.tasks.values()], scan: this.stats };
  }
  task(id) { return [...this.tasks.values()].find((task) => task.id === id); }
  close() {}
}
