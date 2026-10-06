import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { open, stat, readFile, readdir, mkdir } from "node:fs/promises";
import { acquireWorkspaceLock } from "./workspace.js";
import { writeDurableAtomic } from "./state-store.js";
import { dirname } from "node:path";
import { parse as parseToml } from "smol-toml";

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

async function readSchedules(codexHome) {
  const schedules = new Map();
  let errors = 0;
  const root = join(codexHome, "automations");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { return { schedules, errors: error.code === "ENOENT" ? 0 : 1 }; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const config = parseToml(await readFile(join(root, entry.name, "automation.toml"), "utf8"));
      if (config.kind !== "heartbeat" || typeof config.target_thread_id !== "string" || typeof config.id !== "string") continue;
      const list = schedules.get(config.target_thread_id) ?? [];
      list.push({ id: config.id, active: config.status === "ACTIVE" });
      schedules.set(config.target_thread_id, list);
    } catch (error) { if (error.code !== "ENOENT") errors += 1; }
  }
  return { schedules, errors };
}

async function readDoneMarks(path) {
  try {
    const marks = JSON.parse(await readFile(path, "utf8"));
    if (!marks || typeof marks !== "object" || Array.isArray(marks) || Object.values(marks).some((v) => typeof v !== "string")) throw new Error("Invalid TaskChef Done marks.");
    return marks;
  } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}

async function readDatabase(codexHome, fileLimit, now, doneMarks) {
  const module = await sqlite();
  if (!module?.DatabaseSync) throw new Error("node:sqlite is unavailable");
  const { schedules, errors: scheduleErrors } = await readSchedules(codexHome);
  let state;
  let history;
  try {
    state = new module.DatabaseSync(join(codexHome, "state_5.sqlite"), { readOnly: true });
    history = new module.DatabaseSync(join(codexHome, "thread_history_1.sqlite"), { readOnly: true });
    const eligible = `coalesce(thread_source, '') NOT IN ('subagent', 'guardian_review')
      AND CASE WHEN json_valid(source) THEN json_type(source, '$.subagent') IS NULL ELSE 1 END
      AND NOT EXISTS (SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = threads.id)`;
    // Filter against actual turns before the display limit, so empty chats do not
    // displace real work or inflate the outside-limit count.
    const turns = new Map(history.prepare(`SELECT thread_id, turn_id, status, started_at, first_user_item_id
      FROM (SELECT *, row_number() OVER (PARTITION BY thread_id ORDER BY rollout_ordinal DESC) AS latest FROM thread_turns)
      WHERE latest = 1`).all().map((row) => [row.thread_id, row]));
    const eligibleRows = state.prepare(`SELECT id, name, title, cwd, archived, created_at_ms, updated_at_ms, recency_at_ms, rollout_path,
      (SELECT count(*) FROM thread_spawn_edges WHERE parent_thread_id = threads.id) AS child_count
      FROM threads WHERE ${eligible} ORDER BY recency_at_ms DESC`).all().filter((row) => turns.has(row.id));
    const rows = eligibleRows.slice(0, fileLimit);
    const input = history.prepare("SELECT item_json FROM thread_items WHERE thread_id = ? AND item_id = ?");
    const tasks = rows.map((row) => {
      const turn = turns.get(row.id);
      const updatedMs = Math.max(row.updated_at_ms || row.recency_at_ms || row.created_at_ms, (turn.started_at || 0) * 1000);
      const active = !row.archived && turn.status === "inProgress" && now - updatedMs < ACTIVE_WINDOW_MS;
      const chatSchedules = schedules.get(row.id) ?? [];
      const scheduled = chatSchedules.some((schedule) => schedule.active);
      let inputSource = "unverified";
      let inputScheduleActive = false;
      if (turn.first_user_item_id) {
        const raw = input.get(row.id, turn.first_user_item_id)?.item_json;
        if (raw) {
          const item = JSON.parse(raw);
          const text = (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
          const marker = /^\s*<heartbeat>\s*<automation_id>([^<]+)<\/automation_id>/.exec(text);
          const inputSchedule = marker && !item.clientId && chatSchedules.find((schedule) => schedule.id === marker[1].trim());
          if (inputSchedule) { inputSource = "scheduled"; inputScheduleActive = inputSchedule.active; }
          else if (!marker && item.clientId) inputSource = "ordinary";
        }
      }
      const manualDone = doneMarks[row.id] === turn.turn_id;
      const status = row.archived || manualDone ? "completed" : active ? "working"
        : ["failed", "interrupted"].includes(turn.status) ? "interrupted"
          : turn.status === "completed" ? inputScheduleActive ? "scheduled" : "needs_input" : null;
      const statusLabel = status === "completed" ? "Done" : status === "working" ? "Running" : status === "needs_input" ? "Waiting for input/review" : status === "scheduled" ? "Scheduled" : status === "interrupted" ? "Interrupted" : "Unverified";
      const reason = row.archived ? "Chat is archived." : manualDone ? "Marked Done in TaskChef Next. A new turn resets this mark."
        : active ? "Latest turn is in progress; recent activity is recorded."
          : turn.status === "inProgress" ? "Old inProgress record; current activity cannot be confirmed."
            : status === "scheduled" ? "Latest turn was a scheduled heartbeat; an active schedule remains."
              : status === "needs_input" ? "Latest turn ended. Chat remains open for input or review."
                : status === "interrupted" ? `Latest turn is ${turn.status}.` : "Latest turn state is unrecognized.";
      const cwd = row.cwd || "";
      return {
        id: row.id, title: row.name?.trim() || row.title?.trim() || `Codex chat ${row.id.slice(0, 8)}`,
        instruction: "Chat name and title are local metadata and can contain user text.",
        summary: row.child_count ? `${reason} Spawned ${row.child_count} direct subagent ${row.child_count === 1 ? "chat" : "chats"}.` : reason,
        status, statusLabel, scheduled, manualDone, inputSource,
        createdAt: iso(row.created_at_ms || updatedMs), updatedAt: iso(updatedMs),
        updatedBy: "Local Codex database", project: { name: basename(cwd) || cwd || "Unknown project", path: cwd, githubRepos: [] },
        threadId: row.id, turnRef: turn.turn_id, turnId: turn.turn_id, lastResult: null, latestTurn: null,
        observed: { archive: Boolean(row.archived), lastTurnEvent: turn.status, lastTurnEventAt: turn.started_at ? iso(turn.started_at * 1000) : null, recentFileActivity: active, directChildCount: row.child_count },
      };
    });
    return { tasks, rolloutPaths: new Map(rows.map((row) => [row.id, row.rollout_path])), scan: {
      source: "database", mode: "database", checkedAt: iso(now), intervalSeconds: 5,
      visibleFiles: tasks.length, indexedFiles: eligibleRows.length, unreadFiles: Math.max(0, eligibleRows.length - tasks.length), fileLimit,
      activeFiles: null, archivedFiles: null, parsedFiles: null, errors: 0, scheduleErrors,
      sources: ["state_5.sqlite:threads", "state_5.sqlite:thread_spawn_edges", "thread_history_1.sqlite:thread_turns", "thread_history_1.sqlite:thread_items", "automations/*/automation.toml"],
      fields: ["session ID", "name", "title", "timestamps", "project directory", "archive flag", "thread source", "direct child count", "latest turn status", "heartbeat marker", "schedule flag"],
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
  constructor({ codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), now = () => Date.now(), fileLimit = FILE_LIMIT, statePath = join(homedir(), ".agents", "taskchef-next", "done.json"), nodeVersion = process.versions.node } = {}) {
    this.codexHome = codexHome;
    this.now = now;
    this.fileLimit = fileLimit;
    this.nodeVersion = nodeVersion;
    this.statePath = statePath;
    this.mutation = Promise.resolve();
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
      const database = await readDatabase(this.codexHome, this.fileLimit, now, await readDoneMarks(this.statePath));
      const nextTasks = new Map(database.tasks.map((task) => [task.id, task]));
      const signature = (tasks) => [...tasks.values()].map((task) => `${task.id}:${task.title}:${task.project.path}:${task.updatedAt}:${task.status}:${task.summary}:${task.observed.archive}:${task.observed.lastTurnEvent}:${task.observed.directChildCount ?? ""}:${task.scheduled}:${task.inputSource}:${task.turnId}`).join("|");
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
  async setDone(id, expectedTurnId, done) {
    const action = this.mutation.then(async () => {
      const snapshot = await this.refresh({ force: true });
      if (!snapshot.healthy) throw new Error(snapshot.scan.error);
      const task = this.task(id);
      if (!task || task.turnId !== expectedTurnId) throw new Error("Chat changed. Refresh and try again.");
      if (task.observed.archive || task.observed.lastTurnEvent === "inProgress") throw new Error("Archived or in-progress chats cannot be marked from TaskChef Next.");
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const release = await acquireWorkspaceLock(dirname(this.statePath));
      try {
        const marks = await readDoneMarks(this.statePath);
        if (done) marks[id] = expectedTurnId;
        else delete marks[id];
        await writeDurableAtomic(this.statePath, JSON.stringify(marks));
      } finally { await release(); }
      await this.refresh({ force: true });
      return this.task(id);
    });
    this.mutation = action.catch(() => {});
    return action;
  }
  close() {}
}
