import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { open, stat } from "node:fs/promises";

const FILE_LIMIT = 300;
const HEAD_BYTES = 32 * 1024;
const META_LINE_BYTES = 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const ACTIVE_WINDOW_MS = 2 * 60_000;
let sqliteModule;
class UnsupportedNodeVersionError extends Error {}

function supportsReadOnlySqlite(version) {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 23 || (major === 23 && minor >= 2) || (major === 22 && minor >= 18);
}

async function sqlite() {
  if (sqliteModule === undefined) sqliteModule = import("node:sqlite");
  return sqliteModule;
}

function iso(ms) { return new Date(ms).toISOString(); }

async function readDatabase(codexHome, fileLimit, now) {
  const module = await sqlite();
  if (!module?.DatabaseSync) throw new Error("node:sqlite is unavailable");
  let state;
  let history;
  try {
    state = new module.DatabaseSync(join(codexHome, "state_5.sqlite"), { readOnly: true });
    history = new module.DatabaseSync(join(codexHome, "thread_history_1.sqlite"), { readOnly: true });
    const eligible = `coalesce(thread_source, '') NOT IN ('subagent', 'guardian_review')
      AND NOT EXISTS (SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = threads.id)`;
    const rows = state.prepare(`SELECT id, name, title, cwd, archived, created_at_ms, updated_at_ms, recency_at_ms, rollout_path,
      (SELECT count(*) FROM thread_spawn_edges WHERE parent_thread_id = threads.id) AS child_count
      FROM threads WHERE ${eligible} ORDER BY recency_at_ms DESC LIMIT ?`).all(fileLimit);
    const total = state.prepare(`SELECT count(*) AS count FROM threads WHERE ${eligible}`).get().count;
    const latest = history.prepare("SELECT status FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1");
    const tasks = rows.map((row) => {
      const turnStatus = latest.get(row.id)?.status ?? null;
      const updatedMs = row.updated_at_ms || row.recency_at_ms || row.created_at_ms;
      const active = !row.archived && turnStatus === "inProgress" && now - updatedMs < ACTIVE_WINDOW_MS;
      const activity = active ? "A turn is marked in progress and changed recently; live activity is unverified."
        : turnStatus === "inProgress" ? "A turn is marked in progress, but recent activity is unverified."
          : turnStatus ? `Latest turn is ${turnStatus}; task outcome is unknown.`
            : "No turn status is available; task outcome is unknown.";
      const summary = row.child_count ? `${activity} Spawned ${row.child_count} direct subagent ${row.child_count === 1 ? "chat" : "chats"}.` : activity;
      const cwd = row.cwd || "";
      return {
        id: row.id, title: row.name?.trim() || row.title?.trim() || `Codex chat ${row.id.slice(0, 8)}`,
        instruction: "Chat name and title are local metadata and can contain user text.",
        summary, status: active ? "working" : null,
        createdAt: iso(row.created_at_ms || updatedMs), updatedAt: iso(updatedMs),
        updatedBy: "Local Codex database", project: { name: basename(cwd) || cwd || "Unknown project", path: cwd, githubRepos: [] },
        threadId: row.id, turnRef: null, turnId: null, lastResult: null, latestTurn: null,
        observed: { archive: Boolean(row.archived), lastTurnEvent: turnStatus, lastTurnEventAt: null, recentFileActivity: active, directChildCount: row.child_count },
      };
    });
    return { tasks, rolloutPaths: new Map(rows.map((row) => [row.id, row.rollout_path])), scan: {
      source: "database", mode: "database", checkedAt: iso(now), intervalSeconds: 5,
      visibleFiles: tasks.length, indexedFiles: total, unreadFiles: Math.max(0, total - tasks.length), fileLimit,
      activeFiles: null, archivedFiles: null, parsedFiles: null, errors: 0,
      sources: ["state_5.sqlite:threads", "state_5.sqlite:thread_spawn_edges", "thread_history_1.sqlite:thread_turns"],
      fields: ["session ID", "name", "title", "timestamps", "project directory", "archive flag", "thread source", "direct child count", "latest turn status"],
    } };
  } finally { history?.close(); state?.close(); }
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
  constructor({ codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), now = () => Date.now(), fileLimit = FILE_LIMIT, nodeVersion = process.versions.node } = {}) {
    this.codexHome = codexHome;
    this.now = now;
    this.fileLimit = fileLimit;
    this.nodeVersion = nodeVersion;
    this.tasks = new Map();
    this.rolloutPaths = new Map();
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
    this.pending = this.refreshSource(this.now()).finally(() => { this.pending = null; });
    return this.pending;
  }
  async refreshSource(now) {
    try {
      if (!supportsReadOnlySqlite(this.nodeVersion)) throw new UnsupportedNodeVersionError(`TaskChef Next requires Node.js 22.18+, 23.2+, or 24+ for read-only SQLite (current: ${this.nodeVersion}).`);
      const database = await readDatabase(this.codexHome, this.fileLimit, now);
      const nextTasks = new Map(database.tasks.map((task) => [task.id, task]));
      const signature = (tasks) => [...tasks.values()].map((task) => `${task.id}:${task.title}:${task.project.path}:${task.updatedAt}:${task.status}:${task.summary}:${task.observed.archive}:${task.observed.lastTurnEvent}:${task.observed.directChildCount ?? ""}`).join("|");
      if (this.stats?.mode !== "database" || signature(this.tasks) !== signature(nextTasks)) this.revision += 1;
      this.tasks = nextTasks;
      this.rolloutPaths = database.rolloutPaths;
      this.stats = database.scan;
      return this.snapshot();
    } catch (error) {
      if (this.stats?.mode !== "error" || this.tasks.size) this.revision += 1;
      this.tasks = new Map();
      this.rolloutPaths = new Map();
      this.stats = { source: "database", mode: "error", checkedAt: iso(now), error: error instanceof UnsupportedNodeVersionError ? error.message : "Codex databases are unavailable or incompatible." };
      return this.snapshot();
    }
  }
  snapshot() {
    return { healthy: this.stats?.mode !== "error", revision: this.revision, tasks: [...this.tasks.values()], scan: this.stats };
  }
  task(id) { return this.tasks.get(id); }
  async taskDetail(id) {
    const task = this.task(id);
    if (!task) return null;
    try {
      const path = this.rolloutPaths.get(id);
      if (typeof path !== "string" || !isAbsolute(path)) return task;
      const info = await stat(path);
      if (!info.isFile()) return task;
      const log = await readSession({ path, id, archive: task.observed.archive, mtimeMs: info.mtimeMs }, this.now());
      return { ...task, observed: { ...task.observed,
        userMessages: log.observed.userMessages,
        assistantMessages: log.observed.assistantMessages,
        sampledBytes: log.observed.sampledBytes,
        fileBytes: log.observed.fileBytes,
      } };
    } catch { return task; } // Optional log detail never changes database status or availability.
  }
  close() {}
}
