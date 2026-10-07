import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionScanner } from "../src/codex-session-scanner.js";

const id = "0199aabb-ccdd-7eef-8abc-0123456789ab";
const line = (type, payload) => JSON.stringify({ type, timestamp: "2026-10-05T00:00:00Z", payload }) + "\n";

async function fixture(t) {
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite?.DatabaseSync) { t.skip("node:sqlite is unavailable"); return null; }
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-db-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const state = new sqlite.DatabaseSync(join(home, "state_5.sqlite"));
  const history = new sqlite.DatabaseSync(join(home, "thread_history_1.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, archived INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER, rollout_path TEXT, thread_source TEXT, source TEXT DEFAULT 'vscode')");
  state.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT, PRIMARY KEY (parent_thread_id, child_thread_id))");
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT, turn_id TEXT DEFAULT 'turn-1', started_at INTEGER, first_user_item_id TEXT, rollout_byte_offset INTEGER)");
  history.exec("CREATE TABLE thread_items (thread_id TEXT, item_id TEXT, item_json TEXT)");
  t.after(() => { state.close(); history.close(); });
  return { home, state, history };
}

test("database is the sole inventory and status source", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now();
  const rolloutPath = join(home, "selected.jsonl");
  state.prepare("INSERT INTO threads (id,name,title,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms,rollout_path,thread_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, null, "Private title", "/example/project", 0, now, now, now, rolloutPath, "user");
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?, ?, ?)").run(id, 1, "inProgress");
  await writeFile(rolloutPath, line("session_meta", { id, cwd: "/different" }) + line("event_msg", { type: "task_complete" }));
  const sessions = join(home, "sessions");
  await mkdir(sessions);
  await writeFile(join(sessions, `rollout-2026-10-05T00-00-00-${id}.jsonl`), "malformed\n");
  const scanner = new CodexSessionScanner({ codexHome: home, now: () => now });
  const first = await scanner.refresh();
  assert.equal(first.healthy, true);
  assert.equal(first.scan.source, "database");
  assert.equal(first.tasks[0].project.path, "/example/project");
  assert.equal(first.tasks[0].status, "working");
  assert.doesNotMatch(JSON.stringify(first), /selected\.jsonl/);
  const detail = await scanner.taskDetail(id);
  assert.equal(detail.status, "working");
  assert.equal(detail.observed.lastTurnEvent, "inProgress");
  assert.equal(detail.observed.sampledBytes > 0, true);
  assert.equal(detail.project.path, "/example/project");
  state.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(join(home, "missing.jsonl"), id);
  await scanner.refresh();
  assert.equal((await scanner.taskDetail(id)).observed.sampledBytes, undefined);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?, ?, ?)").run(id, 2, "failed");
  const next = await scanner.refresh();
  assert.equal(next.tasks[0].status, "interrupted");
  assert.equal(next.tasks[0].observed.lastTurnEvent, "failed");
});

test("chat name takes precedence over title, with title and ID fallbacks", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now();
  state.prepare("INSERT INTO threads (id,name,title,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms,rollout_path,thread_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, "TaskChef Next storage demo", "Old title", "/example/project", 0, now, now, now, null, "user");
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?, ?, ?)").run(id, 1, "completed");
  const scanner = new CodexSessionScanner({ codexHome: home });
  assert.equal((await scanner.refresh()).tasks[0].title, "TaskChef Next storage demo");
  state.prepare("UPDATE threads SET name = ? WHERE id = ?").run("  ", id);
  assert.equal((await scanner.refresh()).tasks[0].title, "Old title");
  state.prepare("UPDATE threads SET title = ? WHERE id = ?").run("", id);
  assert.equal((await scanner.refresh()).tasks[0].title, `Codex chat ${id.slice(0, 8)}`);
});

test("inventory excludes child chats and Guardian reviews but shows direct child counts on parents", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now();
  const insert = state.prepare("INSERT INTO threads (id,name,title,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms,rollout_path,thread_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const parent = "parent";
  insert.run(parent, "Parent", "", "/example/project", 0, now, now, now - 2, null, "user");
  insert.run("other", "Other", "", "/example/project", 0, now, now, now - 1, null, null);
  insert.run("older", "Older", "", "/example/project", 0, now, now, now - 3, null, "automation");
  insert.run("child", "Child", "", "/example/project", 0, now, now, now + 2, null, "subagent");
  insert.run("legacy-child", "Legacy child", "", "/example/project", 0, now, now, now + 3, null, null);
  insert.run("guardian", "Guardian review", "", "/example/project", 0, now, now, now + 1, null, "guardian_review");
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run(parent, "child", "open");
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run(parent, "legacy-child", "open");
  for (const chat of [parent, "other", "older"]) history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?, ?, ?)").run(chat, 1, "completed");
  const scanner = new CodexSessionScanner({ codexHome: home, fileLimit: 2 });
  const first = await scanner.refresh();
  assert.deepEqual(first.tasks.map((task) => task.id), ["other", parent]);
  assert.equal(first.scan.indexedFiles, 3);
  assert.equal(first.scan.visibleFiles, 2);
  assert.equal(first.scan.unreadFiles, 1);
  assert.match(first.tasks[1].summary, /Spawned 2 direct subagent chats\./);
  assert.equal(first.tasks[1].observed.directChildCount, 2);
  assert.equal(first.tasks[0].observed.directChildCount, 0);
  assert.equal(scanner.task("child"), undefined);
  assert.equal(scanner.task("legacy-child"), undefined);
  assert.equal(await scanner.taskDetail("guardian"), null);
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run(parent, "another-child", "open");
  const next = await scanner.refresh();
  assert.ok(next.revision > first.revision);
  assert.match(next.tasks[1].summary, /Spawned 3 direct subagent chats\./);
  assert.equal(next.tasks[1].observed.directChildCount, 3);
});

test("missing or incompatible databases are fatal and clear prior inventory", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now();
  state.prepare("INSERT INTO threads (id,name,title,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms,rollout_path,thread_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, null, "Title", "/example/project", 0, now, now, now, null, "user");
  const scanner = new CodexSessionScanner({ codexHome: home });
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?, ?, ?)").run(id, 1, "completed");
  assert.equal((await scanner.refresh()).tasks.length, 1);
  history.exec("DROP TABLE thread_turns");
  const failed = await scanner.refresh();
  assert.equal(failed.healthy, false);
  assert.equal(failed.scan.mode, "error");
  assert.deepEqual(failed.tasks, []);
  assert.equal(scanner.task(id), undefined);
  assert.equal(await scanner.taskDetail(id), null);
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT, turn_id TEXT DEFAULT 'turn-1', started_at INTEGER, first_user_item_id TEXT, rollout_byte_offset INTEGER)");
  assert.equal((await scanner.refresh()).healthy, true);
});

test("rollout files never replace a missing database", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-db-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, "sessions");
  await mkdir(sessions);
  await writeFile(join(sessions, `rollout-2026-10-05T00-00-00-${id}.jsonl`), line("session_meta", { id, cwd: "/example/project" }));
  const result = await new CodexSessionScanner({ codexHome: home }).refresh();
  assert.equal(result.healthy, false);
  assert.deepEqual(result.tasks, []);
});

test("unsupported Node versions fail before opening a database", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-version-"));
  t.after(async () => rm(home, { recursive: true, force: true }));
  for (const nodeVersion of ["18.20.8", "22.17.9", "23.0.0", "23.1.0"]) {
    const result = await new CodexSessionScanner({ codexHome: home, nodeVersion }).refresh();
    assert.equal(result.healthy, false);
    assert.deepEqual(result.tasks, []);
    assert.match(result.scan.error, /TaskChef Next requires Node\.js 22\.18\+, 23\.2\+, or 24\+ for read-only SQLite/);
    assert.ok(result.scan.error.includes(nodeVersion));
  }
  assert.deepEqual(await readdir(home), []);
});

test("supported Node versions permit read-only database scans", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  for (const nodeVersion of ["22.18.0", "23.2.0", "24.0.0"]) {
    const result = await new CodexSessionScanner({ codexHome: setup.home, nodeVersion }).refresh();
    assert.equal(result.healthy, true);
  }
});

test("workflow labels distinguish scheduled input, ordinary input, archives, and stale turns", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now();
  await mkdir(join(home, "automations", "routine"), { recursive: true });
  await writeFile(join(home, "automations", "routine", "automation.toml"), 'id = "routine"\nkind = "heartbeat"\nstatus = "ACTIVE"\ntarget_thread_id = "mixed"\n');
  const add = (chat, status, archived = 0, recent = true) => {
    const updated = recent ? now : now - 600_000;
    state.prepare("INSERT INTO threads (id,name,title,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms,rollout_path,thread_source) VALUES (?,?,?, ?,?,?,?, ?,?,?)").run(chat, chat, "", "/project", archived, updated, updated, updated, null, "user");
    history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,first_user_item_id) VALUES (?,?,?,?,?)").run(chat, 1, status, `turn-${chat}`, `input-${chat}`);
  };
  add("running", "inProgress"); add("stale", "inProgress", 0, false);
  add("archived", "inProgress", 1); add("failed", "failed"); add("stopped", "interrupted");
  add("mixed", "completed"); add("ordinary", "completed");
  history.prepare("INSERT INTO thread_items VALUES (?,?,?)").run("mixed", "input-mixed", JSON.stringify({ content: [{ type: "text", text: "<heartbeat>\n<automation_id>routine</automation_id>\n</heartbeat>" }], clientId: null }));
  const scanner = new CodexSessionScanner({ codexHome: home, now: () => now, statePath: join(home, "done.json") });
  await scanner.refresh();
  assert.equal(scanner.task("running").status, "working");
  assert.equal(scanner.task("stale").status, null);
  assert.equal(scanner.task("archived").status, "completed");
  assert.equal(scanner.task("failed").status, "interrupted");
  assert.equal(scanner.task("stopped").status, "interrupted");
  assert.equal(scanner.task("ordinary").status, "needs_input");
  assert.equal(scanner.task("mixed").status, "scheduled");
  assert.equal(scanner.task("mixed").scheduled, true);
  // A real ordinary input moves the same scheduled chat back to Waiting.
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,first_user_item_id) VALUES (?,?,?,?,?)").run("mixed", 2, "completed", "human-turn", "human-input");
  history.prepare("INSERT INTO thread_items VALUES (?,?,?)").run("mixed", "human-input", JSON.stringify({ content: [{ type: "text", text: "Continue this discussion" }], clientId: "human-client" }));
  await scanner.refresh();
  assert.equal(scanner.task("mixed").status, "needs_input");
  assert.equal(scanner.task("mixed").scheduled, true);
  assert.equal(scanner.task("mixed").inputSource, "ordinary");
  await writeFile(join(home, "automations", "routine", "automation.toml"), 'id = "routine"\nkind = "heartbeat"\nstatus = "PAUSED"\ntarget_thread_id = "mixed"\n');
  await scanner.refresh();
  assert.equal(scanner.task("mixed").scheduled, false);
  // Another active schedule must not make this paused heartbeat Scheduled.
  await mkdir(join(home, "automations", "other"));
  await writeFile(join(home, "automations", "other", "automation.toml"), 'id = "other"\nkind = "heartbeat"\nstatus = "ACTIVE"\ntarget_thread_id = "mixed"\n');
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,first_user_item_id) VALUES (?,?,?,?,?)").run("mixed", 3, "completed", "paused-turn", "input-mixed");
  await scanner.refresh();
  assert.equal(scanner.task("mixed").status, "needs_input");
  assert.equal(scanner.task("mixed").scheduled, true);
  assert.equal(scanner.task("mixed").inputSource, "scheduled");
});

test("empty chats and legacy JSON subagents are filtered before the limit", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  for (const [chat, recency] of [["empty", 4], ["review", 3], ["cli", 2], ["older", 1]]) {
    state.prepare("INSERT INTO threads (id,title,archived,created_at_ms,updated_at_ms,recency_at_ms,source) VALUES (?,?,0,1,1,?,?)").run(chat, chat, recency, chat === "review" ? '{"subagent":"review"}' : "cli");
    if (chat !== "empty") history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?,1,'completed')").run(chat);
  }
  const scanner = new CodexSessionScanner({ codexHome: home, fileLimit: 1, statePath: join(home, "done.json") });
  const snapshot = await scanner.refresh();
  assert.deepEqual(snapshot.tasks.map((task) => task.id), ["cli"]);
  assert.equal(snapshot.scan.indexedFiles, 2);
  assert.equal(snapshot.scan.unreadFiles, 1);
});

test("Done marks persist, can be removed, and reset on a new turn", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now();
  state.prepare("INSERT INTO threads (id,title,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, 'Chat',0,?,?,?)").run(id, now, now, now);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id) VALUES (?,1,'completed','turn-1')").run(id);
  const options = { codexHome: home, statePath: join(home, "done.json") };
  const scanner = new CodexSessionScanner(options);
  await scanner.setDone(id, "turn-1", true);
  assert.equal(scanner.task(id).status, "completed");
  assert.equal((await new CodexSessionScanner(options).refresh()).tasks[0].manualDone, true);
  await scanner.setDone(id, "turn-1", false);
  assert.equal(scanner.task(id).status, "needs_input");
  await scanner.setDone(id, "turn-1", true);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id) VALUES (?,2,'inProgress','turn-2')").run(id);
  await scanner.refresh();
  assert.equal(scanner.task(id).status, "working");
  assert.equal(scanner.task(id).manualDone, false);
  await assert.rejects(scanner.setDone(id, "turn-1", true), /Chat changed/);
  await assert.rejects(scanner.setDone(id, "turn-2", true), /in-progress/);
});

test("selected rollout IDs supply current turns and inputs without reading logs", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const rolloutId = "01a06613-2458-7372-a1af-5159b7e39b61";
  const path = join(home, `rollout-2026-09-03T15-02-05-${id}_${rolloutId}.jsonl`);
  // No log exists: status and input must come from the selected database rows.
  state.prepare("INSERT INTO threads (id,title,archived,created_at_ms,updated_at_ms,recency_at_ms,rollout_path) VALUES (?,?,0,1,1,1,?)").run(id, "Example", path);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id) VALUES (?,999,'interrupted','old-turn')").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,first_user_item_id) VALUES (?,1,'completed','current-turn','current-input')").run(rolloutId);
  history.prepare("INSERT INTO thread_items VALUES (?,?,?)").run(rolloutId, "current-input", JSON.stringify({ content: [{ type: "text", text: "Continue" }], clientId: "human" }));
  const scanner = new CodexSessionScanner({ codexHome: home, statePath: join(home, "done.json") });
  const snapshot = await scanner.refresh();
  assert.equal(snapshot.healthy, true);
  assert.equal(snapshot.tasks[0].id, id);
  assert.equal(snapshot.tasks[0].turnId, "current-turn");
  assert.equal(snapshot.tasks[0].status, "needs_input");
  assert.equal(snapshot.tasks[0].inputSource, "ordinary");
  await scanner.setDone(id, "current-turn", true);
  assert.equal(scanner.task(id).manualDone, true);
  state.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(`${path}.zst`, id);
  assert.equal((await scanner.refresh()).tasks[0].turnId, "current-turn");
  history.prepare("DELETE FROM thread_turns WHERE thread_id=?").run(rolloutId);
  assert.deepEqual((await scanner.refresh()).tasks, []);
});
