import { CodexProjects } from "./codex-projects.js";
import { replyImage, localReplyImage } from "./reply-image.js";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { open, stat, readFile, readdir, mkdir } from "node:fs/promises";
import { acquireWorkspaceLock } from "./workspace.js";
import { writeDurableAtomic } from "./state-store.js";
import { dirname } from "node:path";
import { parse as parseToml } from "smol-toml";

const HEAD_BYTES = 32 * 1024;
const META_LINE_BYTES = 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const ACTIVE_WINDOW_MS = 2 * 60_000;
let sqliteModule;
class UnsupportedNodeVersionError extends Error {}
class DoneStateError extends Error {}
class InvalidRolloutMetadataError extends Error {}
class ProjectMetadataError extends Error {}

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
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new DoneStateError("TaskChef: the local Done state file is unavailable or invalid. Repair that file before changing Done marks.");
  }
}

// Codex keeps a chat ID stable after revert, but selects a new rollout ID.
// Turn and item rows use the rollout ID encoded in the selected filename.
function historyId(row) {
  const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  const name = basename(row.rollout_path || "");
  const match = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${uuid})(?:_(${uuid}))?\\.jsonl(?:\\.zst)?$`).exec(name);
  const timestamp = name.slice(8, 27).replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3");
  const date = new Date(`${timestamp}Z`);
  const validTimestamp = Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === timestamp;
  if (match && validTimestamp) {
    if (match[1].toLowerCase() !== row.id.toLowerCase()) throw new InvalidRolloutMetadataError("TaskChef: the selected rollout filename belongs to a different chat. Current turn lookup is unavailable.");
    return (match[2] || match[1]).toLowerCase();
  }
  if (row.history_mode === "paginated") throw new InvalidRolloutMetadataError("TaskChef: a paginated chat has an invalid selected rollout filename. Current turn lookup is unavailable.");
  // Codex explicitly supports noncanonical filenames for legacy histories.
  return row.id;
}

function readDatabaseRecords(state, history) {
    const eligible = `coalesce(thread_source, '') NOT IN ('subagent', 'guardian_review')
      AND CASE WHEN json_valid(source) THEN json_type(source, '$.subagent') IS NULL ELSE 1 END
      AND NOT EXISTS (SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = threads.id)`;
    const latestTurn = history.prepare(`SELECT turn_id, status, started_at, duration_ms, first_user_item_id, final_agent_item_id
      FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1`);
    const turns = new Map();
    const rows = state.prepare(`SELECT id, name, title, cwd, archived, source, created_at_ms, updated_at_ms, recency_at_ms, rollout_path, history_mode, project_id,
      (SELECT count(*) FROM thread_spawn_edges WHERE parent_thread_id = threads.id) AS child_count
      FROM threads WHERE ${eligible} ORDER BY recency_at_ms DESC`).all().filter((row) => {
      const key = historyId(row);
      const turn = latestTurn.get(key);
      if (!turn) return false;
      turns.set(key, turn);
      return true;
    });
    const input = history.prepare("SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?");
    const latestReply = history.prepare("SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_type = 'agentMessage' ORDER BY rollout_ordinal DESC LIMIT 1");
    const inputs = new Map();
    const replies = new Map();
    for (const row of rows) {
      const key = historyId(row);
      const turn = turns.get(key);
      inputs.set(key, turn.first_user_item_id ? input.get(key, turn.turn_id, turn.first_user_item_id)?.item_json : null);
      replies.set(key, (turn.final_agent_item_id ? input.get(key, turn.turn_id, turn.final_agent_item_id) : latestReply.get(key, turn.turn_id))?.item_json);
    }
    const projects = state.prepare("SELECT id, name FROM projects ORDER BY position, id").all().map((project) => ({
      ...project, roots: state.prepare("SELECT path FROM project_roots WHERE project_id = ? ORDER BY position").all(project.id).map((root) => root.path),
    }));
    const attachments = new Map();
    // Older Codex builds have no attachment registry. Never infer ownership from transcript links.
    if (state.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_attachments'").get()) {
      for (const row of state.prepare("SELECT thread_id, payload FROM thread_attachments WHERE attachment_type = 'pull_request'").all()) {
        const payload = JSON.parse(row.payload);
        if (typeof payload.url !== "string") throw new Error("Invalid PR attachment.");
        const urls = attachments.get(row.thread_id) ?? [];
        if (!urls.includes(payload.url)) urls.push(payload.url);
        attachments.set(row.thread_id, urls);
      }
    }
    return { rows, turns, inputs, replies, projects, attachments };
}

function buildDatabaseSnapshot(records, now, doneMarks, schedules, scheduleErrors, cacheHit) {
    const { rows, turns, inputs, replies } = records;
    const images = records.images ??= new Map();
    const tasks = rows.map((row) => {
      const turn = turns.get(historyId(row));
      const updatedMs = Math.max(row.updated_at_ms || 0, row.recency_at_ms || 0, row.created_at_ms || 0, (turn.started_at || 0) * 1000);
      const active = !row.archived && turn.status === "inProgress";
      const chatSchedules = schedules.get(row.id) ?? [];
      const scheduled = chatSchedules.some((schedule) => schedule.active);
      let inputSource = "unverified";
      let inputScheduleActive = false;
      if (turn.first_user_item_id) {
        const raw = inputs.get(historyId(row));
        if (raw) {
          const item = JSON.parse(raw);
          const text = (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
          const marker = /^\s*<heartbeat>\s*<automation_id>([^<]+)<\/automation_id>/.exec(text);
          const inputSchedule = marker && !item.clientId && chatSchedules.find((schedule) => schedule.id === marker[1].trim());
          if (inputSchedule) { inputSource = "scheduled"; inputScheduleActive = inputSchedule.active; }
          else if (!marker && item.clientId) inputSource = "ordinary";
        }
      }
      const rawReply = replies.get(historyId(row));
      const reply = rawReply ? JSON.parse(rawReply) : null;
      let replyText = reply?.type === "agentMessage" && typeof reply.text === "string" ? reply.text.trim() : "";
      // Heartbeat replies wrap their user-facing text in a message block.
      if (/^<heartbeat>[\s\S]*<\/heartbeat>$/.test(replyText)) {
        replyText = /<message>([\s\S]*?)<\/message>/.exec(replyText)?.[1].trim() || "";
      }
      const replyExcerpt = replyText.slice(0, 2000) || null;
      if (!images.has(row.id)) images.set(row.id, replyImage(replyText));
      const manualDone = !scheduled && doneMarks[row.id] === turn.turn_id && !(records.attachments.get(row.id)?.length);
      const status = row.archived ? "archived" : manualDone ? "completed" : active ? "working"
        : ["failed", "interrupted"].includes(turn.status) ? "interrupted"
          : turn.status === "completed" ? inputScheduleActive ? "scheduled" : "needs_input" : null;
      const statusLabel = status === "archived" ? "Archived" : status === "completed" ? "Done" : status === "working" ? "Running" : status === "needs_input" ? "Waiting for input/review" : status === "scheduled" ? "Scheduled" : status === "interrupted" ? "Interrupted" : "Unverified";
      const reason = row.archived ? "Chat is archived." : manualDone ? "Marked Done in TaskChef. A new turn resets this mark."
        : active ? "Latest selected turn is in progress."
          : status === "scheduled" ? "Latest turn was a scheduled heartbeat; an active schedule remains."
            : status === "needs_input" ? "Latest turn ended. Chat remains open for input or review."
              : status === "interrupted" ? `Latest turn is ${turn.status}.` : "Latest turn state is unrecognized.";
      const cwd = row.cwd || "";
      return {
        id: row.id, title: row.name?.trim() || row.title?.trim() || `Codex chat ${row.id.slice(0, 8)}`,
        instruction: "Chat name and title are local metadata and can contain user text.",
        summary: reason, replyExcerpt, replyImage: images.get(row.id),
        status, statusLabel, scheduled, manualDone, inputSource,
        pullRequests: (records.attachments.get(row.id) ?? []).map((url) => ({ url, state: "unknown", checks: "unknown" })),
        createdAt: iso(row.created_at_ms || updatedMs), updatedAt: iso(updatedMs),
        updatedBy: "Local Codex database", project: { id: row.project_id, name: basename(cwd) || cwd || "Unknown project", path: cwd, githubRepos: [] },
        threadId: row.id, turnRef: turn.turn_id, turnId: turn.turn_id, lastResult: null, latestTurn: null,
        observed: { source: row.source, archive: Boolean(row.archived), lastTurnEvent: turn.status, lastTurnEventAt: turn.started_at ? iso(turn.started_at * 1000) : null, latestTurnDurationMs: turn.status !== "inProgress" && Number.isFinite(turn.duration_ms) && turn.duration_ms >= 0 ? turn.duration_ms : null, recentFileActivity: !row.archived && now - updatedMs < ACTIVE_WINDOW_MS, directChildCount: row.child_count },
      };
    });
    return { tasks, rolloutPaths: new Map(rows.map((row) => [row.id, row.rollout_path])), scan: {
      source: "database", mode: "database", cacheHit, checkedAt: iso(now), intervalSeconds: 5,
      visibleFiles: tasks.length, indexedFiles: tasks.length, unreadFiles: 0,
      activeFiles: null, archivedFiles: null, parsedFiles: null, errors: 0, scheduleErrors,
      sources: ["state_5.sqlite:threads", "state_5.sqlite:thread_spawn_edges", "thread_history_1.sqlite:thread_turns", "thread_history_1.sqlite:thread_items", "automations/*/automation.toml"],
      fields: ["session ID", "name", "title", "timestamps", "project directory", "archive flag", "thread source", "direct child count", "latest turn status", "heartbeat marker", "schedule flag"],
    } };
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
  constructor({ codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), now = () => Date.now(), statePath = join(homedir(), ".agents", "taskchef-next", "done.json"), nodeVersion = process.versions.node } = {}) {
    this.codexHome = codexHome;
    this.now = now;
    this.projectCatalog = new CodexProjects(codexHome);
    this.projects = [];
    this.nodeVersion = nodeVersion;
    this.statePath = statePath;
    this.mutation = Promise.resolve();
    this.tasks = new Map();
    this.rolloutPaths = new Map();
    this.revision = 0;
    this.stats = null;
    this.pending = null;
    this.forcedPending = null;
    this.connections = null;
    this.databaseCache = null;
    this.doneCache = null;
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
    this.pending = this.refreshSource(this.now(), force).finally(() => { this.pending = null; });
    return this.pending;
  }
  async doneMarks(force) {
    let stamp;
    try {
      const info = await stat(this.statePath, { bigint: true });
      stamp = `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
    } catch (error) {
      if (error.code !== "ENOENT") throw new DoneStateError("TaskChef: the local Done state file is unavailable or invalid. Repair that file before changing Done marks.");
      stamp = "missing";
    }
    if (!force && this.doneCache?.stamp === stamp) return this.doneCache.marks;
    // Capture the stamp before reading. A concurrent rewrite is checked again
    // on the next poll; mutation paths always read the file under their lock.
    const marks = stamp === "missing" ? {} : await readDoneMarks(this.statePath);
    this.doneCache = { stamp, marks };
    return marks;
  }
  async databaseRecords(force) {
    const paths = [join(this.codexHome, "state_5.sqlite"), join(this.codexHome, "thread_history_1.sqlite")];
    const identities = await Promise.all(paths.map(async (path) => {
      const info = await stat(path, { bigint: true });
      return `${info.dev}:${info.ino}`;
    }));
    if (!this.connections || JSON.stringify(identities) !== JSON.stringify(this.connections.identities)) {
      this.close();
      const module = await sqlite();
      let state;
      try {
        state = new module.DatabaseSync(paths[0], { readOnly: true });
        const history = new module.DatabaseSync(paths[1], { readOnly: true });
        this.connections = { state, history, identities };
      } catch (error) { state?.close(); throw error; }
    }
    const { state, history } = this.connections;
    // Compare versions only on these same connections. Capture before querying:
    // a commit during a snapshot must trigger another read on the next poll.
    const versions = [state.prepare("PRAGMA data_version").get().data_version, history.prepare("PRAGMA data_version").get().data_version];
    const cacheHit = !force && this.databaseCache && JSON.stringify(versions) === JSON.stringify(this.databaseCache.versions);
    if (!cacheHit) this.databaseCache = { versions, records: readDatabaseRecords(state, history) };
    return { records: this.databaseCache.records, cacheHit: Boolean(cacheHit) };
  }
  async refreshSource(now, force) {
    try {
      if (!supportsReadOnlySqlite(this.nodeVersion)) throw new UnsupportedNodeVersionError(`TaskChef requires Node.js 22.18+, 23.2+, or 24+ for read-only SQLite (current: ${this.nodeVersion}).`);
      const { records, cacheHit } = await this.databaseRecords(force);
      const doneMarks = await this.doneMarks(force);
      const { schedules, errors: scheduleErrors } = await readSchedules(this.codexHome);
      const database = buildDatabaseSnapshot(records, now, doneMarks, schedules, scheduleErrors, cacheHit);
      let grouped;
      try { grouped = await this.projectCatalog.group(database.tasks, records.projects); }
      catch { throw new ProjectMetadataError("TaskChef cannot read Codex project metadata. Check .codex-global-state.json and the project worktree metadata, then refresh."); }
      const nextTasks = new Map(grouped.tasks.map((task) => [task.id, task]));
      const signature = (tasks) => JSON.stringify([...tasks.values()].map((task) => [
        task.id, task.title, task.project.path, task.project.id, task.project.name, task.updatedAt, task.status, task.summary,
        task.observed.archive, task.observed.lastTurnEvent, task.observed.directChildCount, task.observed.latestTurnDurationMs,
        task.scheduled, task.inputSource, task.turnId, task.replyExcerpt, task.replyImage, task.pullRequests,
      ]));
      if (this.stats?.mode !== "database" || signature(this.tasks) !== signature(nextTasks) || JSON.stringify(this.projects) !== JSON.stringify(grouped.projects)) this.revision += 1;
      this.tasks = nextTasks;
      this.projects = grouped.projects;
      this.rolloutPaths = database.rolloutPaths;
      this.stats = database.scan;
      return this.snapshot();
    } catch (error) {
      this.close();
      if (this.stats?.mode !== "error" || this.tasks.size) this.revision += 1;
      this.tasks = new Map();
      this.projects = [];
      this.rolloutPaths = new Map();
      this.stats = { source: "database", mode: "error", checkedAt: iso(now), error: error instanceof UnsupportedNodeVersionError || error instanceof DoneStateError || error instanceof InvalidRolloutMetadataError || error instanceof ProjectMetadataError ? error.message : "Codex databases are unavailable or incompatible." };
      return this.snapshot();
    }
  }
  snapshot() {
    return { healthy: this.stats?.mode !== "error", revision: this.revision, tasks: [...this.tasks.values()], projects: this.projects, scan: this.stats };
  }
  task(id) { return this.tasks.get(id); }
  async taskImage(id, expectedTurnId, expectedUrl) {
    const snapshot = await this.refresh();
    if (!snapshot.healthy) throw new Error(snapshot.scan.error);
    const task = this.task(id);
    if (!task || task.turnId !== expectedTurnId || task.replyImage?.url !== expectedUrl) return null;
    try { return await localReplyImage(task.replyImage.url); } catch { return null; }
  }
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
      if (done && task.scheduled) throw new Error("Pause all active schedules before marking this chat Done.");
      if (done && task.pullRequests?.length) throw new Error("Chats with attached PRs use GitHub merge status. Mark Done is only available without PR attachments.");
      if (task.observed.archive || task.observed.lastTurnEvent === "inProgress") throw new Error("Archived or in-progress chats cannot be marked from TaskChef.");
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
  close() {
    this.connections?.history.close();
    this.connections?.state.close();
    this.connections = null;
    this.databaseCache = null;
    this.doneCache = null;
  }
}
