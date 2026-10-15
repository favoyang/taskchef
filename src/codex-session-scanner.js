import { aggregateUsage } from "./usage-analytics.js";
import { openRollout, rolloutChunks } from "./codex-rollout.js";
import { createHash } from "node:crypto";
import { normalizeUri } from "micromark-util-sanitize-uri";
import { displayUserPrompt, responseAnnotations } from "./user-prompt.js";
import { CodexProjects } from "./codex-projects.js";
import { CodexSessionUsage } from "./codex-session-usage.js";
import { CodexPricing } from "./codex-pricing.js";
import { replyImage, replyImages, localReplyImage } from "./reply-image.js";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { stat, readFile, readdir, mkdir } from "node:fs/promises";
import { acquireFileLock } from "./file-lock.js";
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
  // The desktop scheduler stores its actual/nominal next run here, outside TOML.
  let runtime;
  try {
    const path = join(codexHome, "sqlite", "codex-dev.db");
    await stat(path);
    const { DatabaseSync } = await sqlite();
    runtime = new DatabaseSync(path, { readOnly: true });
    const fields = runtime.prepare("PRAGMA table_info(automations)").all().map(row => row.name);
    if (fields.includes("next_run_at")) {
      const nominal = fields.includes("next_run_nominal_at") ? "next_run_nominal_at" : "NULL";
      for (const row of runtime.prepare(`SELECT id, target_thread_id, next_run_at, ${nominal} AS nominal FROM automations WHERE kind = 'heartbeat' AND status = 'ACTIVE'`).all()) {
        const schedule = schedules.get(row.target_thread_id)?.find(schedule => schedule.id === row.id && schedule.active);
        const ms = row.next_run_at == null ? null : row.nominal ?? row.next_run_at;
        if (schedule && Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime())) schedule.nextRunAt = iso(ms);
      }
    }
  } catch (error) { if (error.code !== "ENOENT") errors += 1; }
  finally { runtime?.close(); }
  return { schedules, errors };
}

// Optional desktop queue. Keep attachment bytes out of board snapshots.
async function readPromptQueue(codexHome, imageCache) {
  const activePaths = new Set();
  const resolvedSources = new Map();
  const prompts = new Map();
  const images = new Map();
  let database;
  let errors = 0;
  try {
    const path = join(codexHome, "queue_1.sqlite");
    await stat(path);
    const { DatabaseSync } = await sqlite();
    database = new DatabaseSync(path, { readOnly: true });
    for (const row of database.prepare("SELECT id, thread_id, payload_json FROM queued_items ORDER BY queue_order, created_at_ms, id").all()) {
      try {
        const input = JSON.parse(row.payload_json)?.UserInput;
        if (!Array.isArray(input?.content)) continue;
        const rawText = input.content.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
        const text = displayUserPrompt(rawText);
        const media = [];
        for (const part of input.content) {
          if (part.type === "text" && typeof part.text === "string") {
            media.push(...replyImages(displayUserPrompt(part.text), text).map(image => ({ ...image, source: image.url })));
            continue;
          }
          if (part.type !== "image" || typeof part.image_url !== "string") continue;
          const data = part.image_url;
          // Queue images are already embedded by Codex. Never fetch remote media.
          if (data.length > 8 * 1024 * 1024 + 64 || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) continue;
          if (!resolvedSources.has(data)) {
            const bytes = Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
            if (bytes.length > 6 * 1024 * 1024) continue;
            resolvedSources.set(data, { source: data, identity: createHash("sha256").update(bytes).digest("hex") });
          }
          media.push({ alt: `Queued image ${media.length + 1}`, source: data });
        }
        // Codex can supply the same attachment as a local reference and embedded
        // bytes. Compare validated image bytes, preserving first occurrence order.
        const uniqueMedia = [];
        const seenMedia = new Set();
        for (const image of media) {
          let resolved = resolvedSources.get(image.source);
          if (!resolved) {
            let source = image.source;
            let fingerprint;
            if (!source.startsWith("data:")) {
              activePaths.add(source);
              try {
                const info = await stat(source).catch(error => {
                  if (error.code !== "ENOENT") throw error;
                  return stat(decodeURIComponent(source));
                });
                fingerprint = JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
                const cached = imageCache.get(source);
                if (cached?.fingerprint === fingerprint) resolved = cached;
                else source = await localReplyImage(source, { maxBytes: 6 * 1024 * 1024 }) ?? source;
              } catch { imageCache.delete(source); /* Retry unavailable local images on a later scan. */ }
            }
            if (!resolved) {
              const identity = createHash("sha256").update(source.startsWith("data:") ? Buffer.from(source.slice(source.indexOf(",") + 1), "base64") : source).digest("hex");
              resolved = { source, identity };
              if (fingerprint && source.startsWith("data:")) imageCache.set(image.source, { ...resolved, fingerprint });
            }
            resolvedSources.set(image.source, resolved);
          }
          const { source, identity } = resolved;
          if (seenMedia.has(identity)) continue;
          seenMedia.add(identity);
          uniqueMedia.push({ ...image, source });
        }
        const promptImages = uniqueMedia.map((image, index) => {
          const url = `taskchef-queue:${row.id}:${index}:${createHash("sha256").update(image.source).digest("hex").slice(0, 16)}`;
          images.set(`${row.thread_id}:${url}`, image.source);
          return { url, alt: image.alt };
        });
        const list = prompts.get(row.thread_id) ?? [];
        list.push({ id: row.id, text, images: promptImages });
        prompts.set(row.thread_id, list);
      } catch { errors += 1; }
    }
  } catch (error) { if (error.code !== "ENOENT") errors += 1; }
  finally {
    database?.close();
    for (const path of imageCache.keys()) if (!activePaths.has(path)) imageCache.delete(path);
  }
  return { prompts, images, errors };
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

function delegatedPrompt(item) {
  if (item?.type !== "functionCallOutput" || item.namespace !== "codex_app" || item.name !== "create_thread" || typeof item.output !== "string") return null;
  const match = /^\s*<codex_delegation>\s*<source_thread_id>[^<>]+<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/.exec(item.output);
  return match ? match[1] : null;
}

function unansweredQuestions(records) {
  const questions = new Map();
  const answers = new Set();
  for (const record of records) {
    let item;
    try { item = JSON.parse(record.item_json); } catch { continue; }
    if (item.type === "agentMessage" && typeof item.id === "string" && Array.isArray(item.questions)) {
      item.questions.forEach((question, index) => {
        if (typeof question?.title === "string" && question.title.trim()) {
          const id = JSON.stringify(["request_user_input_async", item.id, index]);
          questions.set(id, { id, title: question.title, options: Array.isArray(question.options) ? question.options.filter(option => typeof option === "string" && option.trim()) : [] });
        }
      });
    }
    if (item.type !== "userMessage" && !(item.type === "steeringUserMessage" && item.status === "accepted")) continue;
    const content = item.type === "userMessage" ? item.content : item.input;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text") continue;
    const match = /^\s*<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>\s*$/.exec(content[0].text ?? "");
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]);
      for (const answer of Array.isArray(value) ? value : [value]) {
        if (typeof answer?.questionItemId === "string" && typeof answer.answer === "string") answers.add(answer.questionItemId);
      }
    } catch { /* An unrecognized reply cannot prove that the question was answered. */ }
  }
  return [...questions.values()].filter(question => !answers.has(question.id));
}

function readDatabaseRecords(state, history) {
    const eligible = `coalesce(thread_source, '') NOT IN ('subagent', 'guardian_review')
      AND CASE WHEN json_valid(source) THEN json_type(source, '$.subagent') IS NULL ELSE 1 END
      AND NOT EXISTS (SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = threads.id)`;
    const hasPinned = state.prepare("PRAGMA table_info(threads)").all().some(column => column.name === "is_pinned");
    const hasTurnError = history.prepare("PRAGMA table_info(thread_turns)").all().some(column => column.name === "error_json");
    const latestTurn = history.prepare(`SELECT turn_id, status, started_at, duration_ms, first_user_item_id, final_agent_item_id, ${hasTurnError ? "error_json" : "NULL AS error_json"}
      FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1`);
    const turns = new Map();
    const needsAnswers = new Map();
    const allRows = state.prepare(`SELECT id, name, title, cwd, archived, ${hasPinned ? "is_pinned" : "0 AS is_pinned"}, source, created_at_ms, updated_at_ms, recency_at_ms, rollout_path, history_mode, project_id,
      (SELECT count(*) FROM thread_spawn_edges WHERE parent_thread_id = threads.id) AS child_count
      FROM threads WHERE ${eligible} ORDER BY recency_at_ms DESC`).all();
    const rows = allRows.filter((row) => {
      const key = historyId(row);
      const turn = latestTurn.get(key);
      if (!turn) return false;
      turns.set(key, turn);
      return true;
    });
    const input = history.prepare("SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?");
    const latestReply = history.prepare("SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_type = 'agentMessage' ORDER BY rollout_ordinal DESC LIMIT 1");
    const attachCalls = history.prepare("SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_type = 'mcpToolCall'");
    const delegationCalls = history.prepare("SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_type = 'functionCallOutput' ORDER BY rollout_ordinal");
    const questionItems = history.prepare(`SELECT item_json FROM thread_items WHERE thread_id = ? AND turn_id = ?
      AND ((item_type = 'agentMessage' AND json_array_length(item_json, '$.questions') > 0)
        OR (item_type IN ('userMessage', 'steeringUserMessage') AND instr(item_json, 'send_user_message_question_reply') > 0)) ORDER BY rollout_ordinal`);
    const turnAttachments = new Map();
    const inputs = new Map();
    const replies = new Map();
    for (const row of rows) {
      const key = historyId(row);
      const turn = turns.get(key);
      needsAnswers.set(key, unansweredQuestions(questionItems.all(key, turn.turn_id)));
      turnAttachments.set(key, attachCalls.all(key, turn.turn_id).map((row) => JSON.parse(row.item_json))
        .filter((item) => item.server === "codex_app" && item.tool === "attach_artifact" && item.status === "completed" && !item.error && !item.result?.isError
          && item.arguments?.artifact_type === "pull_request" && typeof item.arguments.url === "string")
        .map((item) => item.arguments.url));
      let rawInput = turn.first_user_item_id ? input.get(key, turn.turn_id, turn.first_user_item_id)?.item_json : null;
      if (!rawInput) rawInput = delegationCalls.all(key, turn.turn_id).find(record => delegatedPrompt(JSON.parse(record.item_json)) !== null)?.item_json;
      inputs.set(key, rawInput ?? null);
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
    return { rows, allRows, turns, inputs, replies, projects, attachments, turnAttachments, needsAnswers };
}

function buildDatabaseSnapshot(records, now, doneMarks, schedules, scheduleErrors, cacheHit) {
    const { rows, turns, inputs, replies } = records;
    const images = records.images ??= new Map();
    const content = records.latestContent ??= new Map();
    const tasks = rows.map((row) => {
      const turn = turns.get(historyId(row));
      const updatedMs = Math.max(row.updated_at_ms || 0, row.recency_at_ms || 0, row.created_at_ms || 0, (turn.started_at || 0) * 1000);
      const active = !row.archived && turn.status === "inProgress";
      const chatSchedules = schedules.get(row.id) ?? [];
      const scheduled = chatSchedules.some((schedule) => schedule.active);
      const nextRunAt = chatSchedules.filter(schedule => schedule.active && schedule.nextRunAt).map(schedule => schedule.nextRunAt).sort()[0] ?? null;
      let inputSource = "unverified";
      let inputText = "";
      {
        const raw = inputs.get(historyId(row));
        if (raw) {
          const item = JSON.parse(raw);
          const delegated = delegatedPrompt(item);
          const text = inputText = delegated ?? (item.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
          const marker = /^\s*<heartbeat>\s*<automation_id>([^<]+)<\/automation_id>/.exec(text);
          const inputSchedule = marker && !item.clientId && delegated === null;
          if (inputSchedule) { inputSource = "scheduled"; }
          else if (delegated !== null || (!marker && item.clientId)) inputSource = "ordinary";
        }
      }
      const rawReply = replies.get(historyId(row));
      const reply = rawReply ? JSON.parse(rawReply) : null;
      let replyText = reply?.type === "agentMessage" && typeof reply.text === "string" ? reply.text.trim() : "";
      // Heartbeat replies wrap their user-facing text in a message block.
      if (/^<heartbeat>[\s\S]*<\/heartbeat>$/.test(replyText)) {
        replyText = /<message>([\s\S]*?)<\/message>/.exec(replyText)?.[1].trim() || "";
      }
      const promptText = inputSource === "scheduled"
        ? (/<instructions>([\s\S]*?)<\/instructions>/.exec(inputText)?.[1].trim() || "") : displayUserPrompt(inputText);
      const promptExcerpt = promptText.slice(0, 2000) || null;
      const replyExcerpt = replyText.slice(0, 2000) || null;
      const promptImages = replyImages(promptText);
      const annotations = responseAnnotations(inputText);
      content.set(row.id, { promptText: promptText || null, replyText: replyText || null, promptImages });
      if (!images.has(row.id)) images.set(row.id, replyImage(replyText));
      // Ownership comes from the registry; latest-turn references only narrow that owned set.
      const references = new Set([...`${inputText}\n${replyText}`.matchAll(/https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?(?![A-Za-z0-9_/-])/g)].map((match) => match[0].replace(/\/$/, "")));
      for (const url of records.turnAttachments.get(historyId(row)) ?? []) references.add(url.replace(/\/$/, ""));
      const turnPrs = (records.attachments.get(row.id) ?? []).filter((url) => references.has(url.replace(/\/$/, "")));
      const manualDone = !active && !scheduled && doneMarks[row.id] === turn.turn_id && turnPrs.every(url => (doneMarks[`done-pr:${row.id}`] ?? "").split("\n").includes(url));
      const manualScheduled = scheduled && !active && doneMarks[`scheduled:${row.id}`] === turn.turn_id;
      const status = row.archived ? "archived" : manualDone ? "completed" : manualScheduled ? "scheduled" : active ? "working"
        : ["failed", "interrupted"].includes(turn.status) ? "interrupted"
          : turn.status === "completed" ? scheduled && inputSource === "scheduled" ? "scheduled" : "needs_input" : null;
      let turnError = null;
      if (status === "interrupted" && turn.error_json) {
        try {
          const error = JSON.parse(turn.error_json);
          if (typeof error?.message === "string") turnError = error.message.trim() || null;
        } catch { /* Invalid optional error metadata must not hide the chat. */ }
      }
      const statusLabel = status === "archived" ? "Archived" : status === "completed" ? "Done" : status === "working" ? "Running" : status === "needs_input" ? "Waiting for input/review" : status === "scheduled" ? "Scheduled" : status === "interrupted" ? "Interrupted" : "Unverified";
      const reason = row.archived ? "Chat is archived." : manualDone ? "Marked Done in TaskChef. A new turn resets this mark."
        : active ? "Latest selected turn is in progress."
          : status === "scheduled" ? manualScheduled ? "Latest human turn acknowledged in TaskChef; an active schedule remains." : "Latest turn was a scheduled heartbeat; an active schedule remains."
            : status === "needs_input" ? "Latest turn ended. Chat remains open for input or review."
              : status === "interrupted" ? `Latest turn is ${turn.status}.` : "Latest turn state is unrecognized.";
      const cwd = row.cwd || "";
      return {
        id: row.id, title: row.name?.trim() || row.title?.trim() || `Codex chat ${row.id.slice(0, 8)}`,
        instruction: "Chat name and title are local metadata and can contain user text.",
        summary: reason, turnError, promptExcerpt, replyExcerpt, annotations, promptImages, promptImage: promptImages[0] ?? null, replyImage: images.get(row.id),
        needsAnswer: !row.archived && (records.needsAnswers.get(historyId(row))?.length ?? 0) > 0,
        pendingQuestions: row.archived ? [] : records.needsAnswers.get(historyId(row)) ?? [],
        status, statusLabel, scheduled, nextRunAt, manualDone, manualScheduled, inputSource,
        pullRequests: turnPrs.map((url) => ({ url, state: "unknown", checks: "unknown" })),
        createdAt: iso(row.created_at_ms || updatedMs), updatedAt: iso(updatedMs),
        updatedBy: "Local Codex database", project: { id: row.project_id, name: basename(cwd) || cwd || "Unknown project", path: cwd, githubRepos: [] },
        threadId: row.id, turnRef: turn.turn_id, turnId: turn.turn_id, lastResult: null, latestTurn: null,
        observed: { pinned: Boolean(row.is_pinned), source: row.source, archive: Boolean(row.archived), lastTurnEvent: turn.status, lastTurnEventAt: turn.started_at ? iso(turn.started_at * 1000) : null, latestTurnDurationMs: turn.status !== "inProgress" && Number.isFinite(turn.duration_ms) && turn.duration_ms >= 0 ? turn.duration_ms : null, recentFileActivity: !row.archived && now - updatedMs < ACTIVE_WINDOW_MS, directChildCount: row.child_count },
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
  const source = await openRollout(file.path);
  const { handle } = source;
  try {
    let size, headEnd, head, tail, contiguous;
    if (source.path.endsWith(".jsonl.zst")) {
      let prefix = Buffer.alloc(0), suffix = Buffer.alloc(0);
      size = 0;
      for await (const chunk of rolloutChunks(source, { highWaterMark: TAIL_BYTES })) {
        size += chunk.length;
        if (prefix.length < META_LINE_BYTES) prefix = Buffer.concat([prefix, chunk.subarray(0, META_LINE_BYTES - prefix.length)]);
        suffix = Buffer.concat([suffix, chunk]);
        if (suffix.length > TAIL_BYTES) suffix = Buffer.from(suffix.subarray(suffix.length - TAIL_BYTES));
      }
      headEnd = Math.min(size, HEAD_BYTES);
      if (!prefix.subarray(0, headEnd).includes(10) && headEnd < size) headEnd = Math.min(size, META_LINE_BYTES);
      head = prefix.subarray(0, headEnd).toString("utf8");
      const tailStart = Math.max(0, size - TAIL_BYTES);
      contiguous = tailStart <= headEnd;
      tail = suffix.subarray(contiguous ? headEnd - tailStart : 0).toString("utf8");
    } else {
      size = source.info.size;
      headEnd = Math.min(size, HEAD_BYTES);
      head = await readSlice(handle, 0, headEnd);
      if (!head.includes("\n") && headEnd < size) {
        headEnd = Math.min(size, META_LINE_BYTES);
        head = await readSlice(handle, 0, headEnd);
      }
      const tailStart = Math.max(0, size - TAIL_BYTES);
      contiguous = tailStart <= headEnd;
      tail = contiguous ? await readSlice(handle, headEnd, size - headEnd) : await readSlice(handle, tailStart, size - tailStart);
    }
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
    const updatedAt = new Date(source.info.mtimeMs).toISOString();
    const projectName = cwd ? basename(cwd) || cwd : "Unknown project";
    const active = !file.archive && lastEvent === "task_started" && now - source.info.mtimeMs < ACTIVE_WINDOW_MS;
    const activity = active ? "A turn started recently; live activity is unverified."
      : lastEvent === "task_complete" ? "Latest recorded turn ended; task outcome is unknown."
        : lastEvent === "turn_aborted" ? "Latest recorded turn stopped; task outcome is unknown."
          : "Task outcome is unknown from the available log segment.";
    return {
      id: file.id, title: `Codex chat ${file.id.slice(0, 8)}`, instruction: "Private request text is not shown in this read-only demo.",
      summary: activity, status: active ? "working" : null, createdAt: createdAt || updatedAt, updatedAt,
      updatedBy: "Local Codex log", project: { name: projectName, path: cwd, githubRepos: [] },
      threadId: file.id, turnRef: null, turnId: null, lastResult: null, latestTurn: null,
      observed: { archive: file.archive, lastTurnEvent: lastEvent || null, lastTurnEventAt: lastEventAt || null, recentFileActivity: !file.archive && now - source.info.mtimeMs < ACTIVE_WINDOW_MS, userMessages, assistantMessages, sampledBytes: Math.min(size, headEnd + TAIL_BYTES), fileBytes: size },
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
    this.sessionUsage = new CodexSessionUsage({ codexHome, now, cacheDir: join(dirname(statePath), "cache", "usage"), legacyCacheDir: join(dirname(statePath), "usage-cache"),
      pricing: new CodexPricing({ cachePath: join(dirname(statePath), "cache", "pricing.json"), legacyCachePath: join(dirname(statePath), "pricing.json"), now }) });
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
  async openDatabases() {
    if (!supportsReadOnlySqlite(this.nodeVersion)) throw new UnsupportedNodeVersionError(`TaskChef requires Node.js 22.18+, 23.2+, or 24+ for read-only SQLite (current: ${this.nodeVersion}).`);
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
    return this.connections;
  }
  async databaseRecords(force) {
    const { state, history } = await this.openDatabases();
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
      const queue = await readPromptQueue(this.codexHome, this.queueImageCache ??= new Map());
      this.queuedImages = queue.images;
      for (const task of database.tasks) task.queuedPrompts = queue.prompts.get(task.id) ?? [];
      database.scan.queueErrors = queue.errors;
      let grouped;
      try { grouped = await this.projectCatalog.group(database.tasks, records.projects); }
      catch { throw new ProjectMetadataError("TaskChef cannot read Codex project metadata. Check .codex-global-state.json and the project worktree metadata, then refresh."); }
      const nextTasks = new Map(grouped.tasks.map((task) => [task.id, task]));
      const signature = (tasks) => JSON.stringify([...tasks.values()].map((task) => [
        task.id, task.title, task.project.path, task.project.id, task.project.name, task.updatedAt, task.status, task.summary, task.turnError,
        task.observed.archive, task.observed.pinned, task.observed.unread, task.observed.lastTurnEvent, task.observed.directChildCount, task.observed.latestTurnDurationMs,
        task.scheduled, task.nextRunAt, task.inputSource, task.turnId, task.promptExcerpt, task.replyExcerpt, task.annotations, task.promptImages, task.promptImage, task.replyImage, task.queuedPrompts, task.needsAnswer, task.pendingQuestions, task.pullRequests,
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
  earlierPullRequest(id) {
    const task = this.task(id);
    if (!task || task.pullRequests?.length || !this.databaseCache?.records) return null;
    const records = this.databaseCache.records;
    const cache = records.earlierPullRequests ??= new Map();
    if (cache.has(id)) return cache.get(id);
    const row = records.rows.find(row => row.id === id);
    const owned = new Set((records.attachments.get(id) ?? []).map(url => url.replace(/\/$/, "")));
    let pr = null;
    if (row && owned.size) {
      // Read only this selected rollout, newest first, and stop at the first owned PR.
      const items = this.connections.history.prepare(`SELECT item_json FROM thread_items
        WHERE thread_id = ? AND turn_id != ? AND item_type IN ('userMessage', 'agentMessage', 'mcpToolCall')
        ORDER BY rollout_ordinal DESC`).iterate(historyId(row), task.turnId);
      for (const record of items) {
        let item;
        try { item = JSON.parse(record.item_json); } catch { continue; }
        if (!item || typeof item !== "object") continue;
        const text = item.type === "agentMessage" ? item.text
          : item.type === "userMessage" ? (item.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n")
            : item.server === "codex_app" && item.tool === "attach_artifact" && item.status === "completed" && !item.error && !item.result?.isError && item.arguments?.artifact_type === "pull_request" ? item.arguments.url : "";
        if (typeof text !== "string") continue;
        const url = [...text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?(?![A-Za-z0-9_/-])/g)].reverse()
          .map(match => match[0].replace(/\/$/, "")).find(url => owned.has(url));
        if (url) { pr = { url, state: "unknown", checks: "unknown" }; break; }
      }
    }
    cache.set(id, pr);
    return pr;
  }
  async taskImage(id, expectedTurnId, expectedUrl) {
    const snapshot = await this.refresh();
    if (!snapshot.healthy) throw new Error(snapshot.scan.error);
    const task = this.task(id);
    if (!task || task.turnId !== expectedTurnId) return null;
    const queuedImage = this.queuedImages?.get(`${id}:${expectedUrl}`);
    if (queuedImage) {
      if (queuedImage.startsWith("data:")) return queuedImage;
      try { return await localReplyImage(queuedImage); } catch { return null; }
    }
    const content = this.databaseCache.records.latestContent.get(id);
    const images = [...(content?.promptImages ?? []), ...replyImages(content?.replyText ?? "")];
    const image = images.find(image => image.url === expectedUrl || normalizeUri(image.url) === expectedUrl);
    if (!image) return null;
    try { return await localReplyImage(image.url); } catch { return null; }
  }
  async taskUsage(id, savedDurations = []) {
    const task = this.task(id);
    if (!task) return null;
    const sessions = this.connections.state.prepare(`WITH RECURSIVE family(id) AS (
      SELECT ? UNION SELECT child_thread_id FROM thread_spawn_edges JOIN family ON parent_thread_id = family.id
    ) SELECT id, rollout_path FROM threads WHERE id IN (SELECT id FROM family)`).all(id);
    return this.sessionUsage.read({ id, latestTurnId: task.turnId, sessions, savedDurations });
  }
  async usageAnalytics({ range, timeZone, settings }) {
    const snapshot = await this.refresh();
    if (!snapshot.healthy) throw new Error(snapshot.scan.error);
    const records = this.databaseCache.records;
    // Analytics inventories every root, even if its latest turn is absent from
    // the board's history database. Its rollout can still hold valid usage.
    const grouped = await this.projectCatalog.group(records.allRows.map(row => ({
      id: row.id, turnId: records.turns.get(historyId(row))?.turn_id ?? null,
      project: { id: row.project_id, path: row.cwd || "", githubRepos: [] }, observed: { source: row.source },
    })), records.projects);
    const families = [];
    const seen = new Set();
    for (const task of grouped.tasks) {
      // History includes archived chats. CLI/exec preferences still apply.
      if ((!settings.showCli && task.observed?.source === "cli") || (!settings.showExec && task.observed?.source === "exec")) continue;
      const sessions = this.connections.state.prepare(`WITH RECURSIVE family(id) AS (
        SELECT ? UNION SELECT child_thread_id FROM thread_spawn_edges JOIN family ON parent_thread_id = family.id
      ) SELECT id, rollout_path FROM threads WHERE id IN (SELECT id FROM family)`).all(task.id).filter(row => !seen.has(row.id));
      if (!sessions.length) continue;
      sessions.forEach(row => seen.add(row.id));
      const usage = await this.sessionUsage.read({ id: task.id, latestTurnId: task.turnId, sessions });
      families.push({ project: task.project, usage });
    }
    return aggregateUsage(families, { range, timeZone, now: this.now() });
  }
  recordedUsage(id, turnId) {
    const result = (this.recordedPending ?? Promise.resolve()).then(() => this.readRecordedUsage(id, turnId));
    this.recordedPending = result.catch(() => {});
    return result;
  }
  async readRecordedUsage(id, turnId) {
    // Dispatcher chats can be exec/subagent sessions that the board intentionally hides.
    // Read their linked family directly, without changing the board's inclusion rules.
    await this.openDatabases();
    const row = this.connections.state.prepare("SELECT id, rollout_path, history_mode FROM threads WHERE id = ?").get(id);
    if (!row) throw new Error("No matching Codex usage session was found.");
    const sessions = this.connections.state.prepare(`WITH RECURSIVE family(id) AS (
      SELECT ? UNION SELECT child_thread_id FROM thread_spawn_edges JOIN family ON parent_thread_id = family.id
    ) SELECT id, rollout_path FROM threads WHERE id IN (SELECT id FROM family)`).all(id);
    const matched = !!turnId && !!this.connections.history.prepare("SELECT 1 FROM thread_turns WHERE thread_id = ? AND turn_id = ?").get(historyId(row), turnId);
    const usage = await this.sessionUsage.read({ id, latestTurnId: matched ? turnId : null, sessions });
    return { ...usage, matchedTurn: matched };
  }
  async taskDetail(id) {
    const task = this.task(id);
    if (!task) return null;
    // Details reads the full owned PR history of the selected rollout.
    // Restrict links to owned PRs; incidental transcript links are not attachments.
    const records = this.databaseCache.records;
    const row = records.rows.find(row => row.id === id);
    const owned = new Set((records.attachments.get(id) ?? []).map(url => url.replace(/\/$/, "")));
    const cachedDetails = records.detailPullRequests ??= new Map();
    let detailPullRequests = cachedDetails.get(id);
    if (!detailPullRequests) {
      const urls = new Set();
      const items = owned.size ? this.connections.history.prepare(`SELECT item_json FROM thread_items
        WHERE thread_id = ? AND item_type IN ('userMessage', 'agentMessage', 'mcpToolCall')
        ORDER BY rollout_ordinal DESC`).iterate(historyId(row)) : [];
      for (const record of items) {
        let item;
        try { item = JSON.parse(record.item_json); } catch { continue; }
        if (!item || typeof item !== "object") continue;
        const text = item.type === "agentMessage" ? item.text
          : item.type === "userMessage" ? (item.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n")
            : item.server === "codex_app" && item.tool === "attach_artifact" && item.status === "completed" && !item.error && !item.result?.isError && item.arguments?.artifact_type === "pull_request" ? item.arguments.url : "";
        if (typeof text !== "string") continue;
        for (const match of [...text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?(?![A-Za-z0-9_/-])/g)].reverse()) {
          const url = match[0].replace(/\/$/, "");
          if (owned.has(url)) urls.add(url);
        }
        if (urls.size === owned.size) break;
      }
      detailPullRequests = [...urls].map(url => ({ url, state: "unknown", checks: "unknown" }));
      cachedDetails.set(id, detailPullRequests);
    }
    const durationCache = records.detailDurations ??= new Map();
    let durations = durationCache.get(id);
    if (!durations) {
      const saved = this.connections.history.prepare(`SELECT turn_id, duration_ms
        FROM thread_turns WHERE thread_id = ? AND status != 'inProgress'`).all(historyId(row));
      durations = { saved, total: saved.reduce((sum, turn) => sum + (turn.duration_ms >= 0 ? turn.duration_ms ?? 0 : 0), 0),
        missing: saved.filter(turn => turn.duration_ms == null || turn.duration_ms < 0).length };
      durationCache.set(id, durations);
    }
    let detail = { ...task, ...records.latestContent.get(id), detailPullRequests, observed: { ...task.observed,
      recordedChatDurationMs: durations.total ?? 0, missingTurnDurations: durations.missing ?? 0 } };
    try {
      const { timeline: _timeline, analyticsPartial: _analyticsPartial, ...sessionUsage } = await this.taskUsage(id, durations.saved);
      detail = { ...detail, sessionUsage, observed: { ...detail.observed,
        ...(sessionUsage.durationTurns ? { recordedChatDurationMs: Math.max(durations.total ?? 0, sessionUsage.durationMs) } : {}),
        historicalTimePartial: sessionUsage.partial || !sessionUsage.durationTurns } };
    } catch { detail.observed.historicalTimePartial = true; }
    try {
      const path = this.rolloutPaths.get(id);
      if (typeof path !== "string" || !isAbsolute(path)) return detail;
      const log = await readSession({ path, id, archive: task.observed.archive }, this.now());
      return { ...detail, observed: { ...detail.observed,
        userMessages: log.observed.userMessages,
        assistantMessages: log.observed.assistantMessages,
        sampledBytes: log.observed.sampledBytes,
        fileBytes: log.observed.fileBytes,
      } };
    } catch { return detail; } // Optional log detail never changes database status or availability.
  }
  async setDone(id, expectedTurnId, done, mergedPrUrls = []) {
    return this.setQueueMark(id, expectedTurnId, done, false, mergedPrUrls);
  }
  async setScheduled(id, expectedTurnId) {
    return this.setQueueMark(id, expectedTurnId, true, true);
  }
  async setQueueMark(id, expectedTurnId, done, scheduled, mergedPrUrls = []) {
    const action = this.mutation.then(async () => {
      const snapshot = await this.refresh({ force: true });
      if (!snapshot.healthy) throw new Error(snapshot.scan.error);
      const task = this.task(id);
      if (!task || task.turnId !== expectedTurnId) throw new Error("Chat changed. Refresh and try again.");
      if (scheduled && (!task.scheduled || task.inputSource !== "ordinary")) throw new Error("Only a chat with an active schedule and a human prompt can return to Scheduled.");
      if (!scheduled && done && task.scheduled) throw new Error("Pause all active schedules before marking this chat Done.");
      if (!scheduled && done && task.pullRequests?.some(pr => !mergedPrUrls.includes(pr.url))) throw new Error("Chats with attached PRs require confirmed merge status before marking Done.");
      if (task.observed.archive || task.observed.lastTurnEvent === "inProgress") throw new Error("Archived or in-progress chats cannot be marked from TaskChef.");
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const release = await acquireFileLock(dirname(this.statePath));
      try {
        const marks = await readDoneMarks(this.statePath);
        const key = scheduled ? `scheduled:${id}` : id;
        if (done) marks[key] = expectedTurnId;
        else delete marks[key];
        if (!scheduled) {
          if (done && task.pullRequests?.length) marks[`done-pr:${id}`] = mergedPrUrls.join("\n");
          else delete marks[`done-pr:${id}`];
        }
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
    this.queuedImages = null;
    this.queueImageCache?.clear();
  }
}
