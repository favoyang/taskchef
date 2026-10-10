import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, rename, stat, utimes } from "node:fs/promises";
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
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, archived INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER, rollout_path TEXT, thread_source TEXT, source TEXT DEFAULT 'vscode', history_mode TEXT DEFAULT 'legacy', project_id TEXT)");
  state.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER)");
  state.exec("CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER)");
  state.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT, PRIMARY KEY (parent_thread_id, child_thread_id))");
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT, turn_id TEXT DEFAULT 'turn-1', started_at INTEGER, duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT, rollout_byte_offset INTEGER)");
  history.exec("CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT, item_type TEXT, rollout_ordinal INTEGER, PRIMARY KEY (thread_id, turn_id, item_id))");
  t.after(() => { state.close(); history.close(); });
  return { home, state, history };
}

test("latest turn duration comes from the selected database turn and is absent while running", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  state.prepare("INSERT INTO threads (id,name,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, 'Duration demo', '/repo', 0, 1, 1, 1)").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,duration_ms) VALUES (?,1,'completed',54300000)").run(id);
  const scanner = new CodexSessionScanner({ codexHome: home });
  t.after(() => scanner.close());
  const initial = await scanner.refresh();
  assert.equal(initial.tasks[0].observed.latestTurnDurationMs, 54300000);
  history.prepare("UPDATE thread_turns SET duration_ms=60000").run();
  const updated = await scanner.refresh();
  assert.equal(updated.tasks[0].observed.latestTurnDurationMs, 60000);
  assert.ok(updated.revision > initial.revision);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,duration_ms) VALUES (?,2,'inProgress',54300000)").run(id);
  assert.equal((await scanner.refresh(true)).tasks[0].observed.latestTurnDurationMs, null);
  history.prepare("UPDATE thread_turns SET status='completed', duration_ms=NULL WHERE rollout_ordinal=2").run();
  assert.equal((await scanner.refresh(true)).tasks[0].observed.latestTurnDurationMs, null);
});

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
  state.prepare("INSERT INTO threads (id,name,title,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms,rollout_path,thread_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, "TaskChef storage demo", "Old title", "/example/project", 0, now, now, now, null, "user");
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?, ?, ?)").run(id, 1, "completed");
  const scanner = new CodexSessionScanner({ codexHome: home });
  assert.equal((await scanner.refresh()).tasks[0].title, "TaskChef storage demo");
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
  const scanner = new CodexSessionScanner({ codexHome: home });
  const first = await scanner.refresh();
  assert.deepEqual(first.tasks.map((task) => task.id), ["other", parent, "older"]);
  assert.equal(first.scan.indexedFiles, 3);
  assert.equal(first.scan.visibleFiles, 3);
  assert.equal(first.scan.unreadFiles, 0);
  assert.doesNotMatch(first.tasks[1].summary, /Spawned/);
  assert.equal(first.tasks[1].observed.directChildCount, 2);
  assert.equal(first.tasks[0].observed.directChildCount, 0);
  assert.equal(scanner.task("child"), undefined);
  assert.equal(scanner.task("legacy-child"), undefined);
  assert.equal(await scanner.taskDetail("guardian"), null);
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run(parent, "another-child", "open");
  const next = await scanner.refresh();
  assert.ok(next.revision > first.revision);
  assert.equal(next.tasks[1].observed.directChildCount, 3);
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
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT, turn_id TEXT DEFAULT 'turn-1', started_at INTEGER, duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT, rollout_byte_offset INTEGER)");
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
    assert.match(result.scan.error, /TaskChef requires Node\.js 22\.18\+, 23\.2\+, or 24\+ for read-only SQLite/);
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

test("workflow labels distinguish scheduled input, ordinary input, archives, and old in-progress turns", async (t) => {
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
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_json) VALUES (?,?,?,?)").run("mixed", "turn-mixed", "input-mixed", JSON.stringify({ content: [{ type: "text", text: "<heartbeat>\n<automation_id>routine</automation_id>\n</heartbeat>" }], clientId: null }));
  const scanner = new CodexSessionScanner({ codexHome: home, now: () => now, statePath: join(home, "done.json") });
  await scanner.refresh();
  assert.equal(scanner.task("running").status, "working");
  assert.equal(scanner.task("stale").status, "working");
  assert.equal(scanner.task("stale").observed.recentFileActivity, false);
  assert.equal(scanner.task("archived").status, "archived");
  assert.equal(scanner.task("failed").status, "interrupted");
  assert.equal(scanner.task("stopped").status, "interrupted");
  assert.equal(scanner.task("ordinary").status, "needs_input");
  assert.equal(scanner.task("mixed").status, "scheduled");
  assert.equal(scanner.task("mixed").scheduled, true);
  // A real ordinary input moves the same scheduled chat back to Waiting.
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,first_user_item_id) VALUES (?,?,?,?,?)").run("mixed", 2, "completed", "human-turn", "human-input");
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_json) VALUES (?,?,?,?)").run("mixed", "human-turn", "human-input", JSON.stringify({ content: [{ type: "text", text: "Continue this discussion" }], clientId: "human-client" }));
  await scanner.refresh();
  assert.equal(scanner.task("mixed").status, "needs_input");
  assert.equal(scanner.task("mixed").scheduled, true);
  assert.equal(scanner.task("mixed").inputSource, "ordinary");
  await writeFile(join(home, "automations", "routine", "automation.toml"), 'id = "routine"\nkind = "heartbeat"\nstatus = "PAUSED"\ntarget_thread_id = "mixed"\n');
  await scanner.refresh();
  assert.equal(scanner.task("mixed").scheduled, false);
  // A chat with another active schedule still has future routine work.
  await mkdir(join(home, "automations", "other"));
  await writeFile(join(home, "automations", "other", "automation.toml"), 'id = "other"\nkind = "heartbeat"\nstatus = "ACTIVE"\ntarget_thread_id = "mixed"\n');
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,first_user_item_id) VALUES (?,?,?,?,?)").run("mixed", 3, "completed", "paused-turn", "input-mixed");
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_json) SELECT thread_id, 'paused-turn', item_id, item_json FROM thread_items WHERE turn_id='turn-mixed'").run();
  await scanner.refresh();
  assert.equal(scanner.task("mixed").status, "scheduled");
  assert.equal(scanner.task("mixed").scheduled, true);
  assert.equal(scanner.task("mixed").inputSource, "scheduled");
});

test("empty chats and subagents are excluded while standalone exec and CLI records stay eligible", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  for (const [chat, recency] of [["exec", 6], ["exec-archived", 5], ["empty", 4], ["review", 3], ["cli", 2], ["older", 1]]) {
    state.prepare("INSERT INTO threads (id,title,archived,created_at_ms,updated_at_ms,recency_at_ms,source) VALUES (?,?,0,1,1,?,?)").run(chat, chat, recency, chat === "review" ? '{"subagent":"review"}' : chat.startsWith("exec") ? "exec" : "cli");
    if (chat === "exec-archived") state.prepare("UPDATE threads SET archived=1 WHERE id=?").run(chat);
    if (chat !== "empty") history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?,1,'completed')").run(chat);
  }
  const scanner = new CodexSessionScanner({ codexHome: home, statePath: join(home, "done.json") });
  const snapshot = await scanner.refresh();
  assert.deepEqual(snapshot.tasks.map((task) => task.id), ["exec", "exec-archived", "cli", "older"]);
  assert.equal(scanner.task("cli").observed.source, "cli");
  assert.equal(scanner.task("exec").updatedAt, new Date(6).toISOString());
  assert.equal(scanner.task("cli").updatedAt, new Date(2).toISOString());
  assert.equal((await scanner.taskDetail("exec")).observed.source, "exec");
  assert.equal((await scanner.taskDetail("exec-archived")).status, "archived");
  assert.equal(snapshot.scan.indexedFiles, 4);
  assert.equal(snapshot.scan.unreadFiles, 0);
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
  // Item IDs need not be unique across turns. Never read this older body.
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_json) VALUES (?,?,?,?)").run(rolloutId, "another-turn", "current-input", "malformed");
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_json) VALUES (?,?,?,?)").run(rolloutId, "current-turn", "current-input", JSON.stringify({ content: [{ type: "text", text: "Continue" }], clientId: "human" }));
  state.prepare("UPDATE threads SET history_mode='paginated' WHERE id=?").run(id);
  const scanner = new CodexSessionScanner({ codexHome: home, statePath: join(home, "done.json") });
  const snapshot = await scanner.refresh();
  assert.equal(snapshot.healthy, true);
  assert.equal(snapshot.tasks[0].id, id);
  assert.equal(snapshot.tasks[0].turnId, "current-turn");
  assert.equal(snapshot.tasks[0].status, "needs_input");
  assert.equal(snapshot.tasks[0].inputSource, "ordinary");
  await scanner.setDone(id, "current-turn", true);
  assert.equal(scanner.task(id).manualDone, true);
  state.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(join(home, `rollout-2026-09-03T15-02-05-${id.toUpperCase()}_${rolloutId.toUpperCase()}.jsonl`), id);
  assert.equal((await scanner.refresh()).tasks[0].turnId, "current-turn");
  state.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(`${path}.zst`, id);
  assert.equal((await scanner.refresh()).tasks[0].turnId, "current-turn");
  history.prepare("DELETE FROM thread_turns WHERE thread_id=?").run(rolloutId);
  assert.deepEqual((await scanner.refresh()).tasks, []);
});

test("all eligible chats remain available beyond the former 300-chat cap", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const insertChat = state.prepare("INSERT INTO threads (id,title,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, ?, 0, 1, 1, ?)");
  const insertTurn = history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?, 1, 'completed')");
  for (let i = 0; i < 305; i++) { insertChat.run(`chat-${i}`, `Chat ${i}`, i + 1); insertTurn.run(`chat-${i}`); }
  const snapshot = await new CodexSessionScanner({ codexHome: home, statePath: join(home, "done.json") }).refresh();
  assert.equal(snapshot.healthy, true);
  assert.equal(snapshot.tasks.length, 305);
  assert.equal(snapshot.tasks.at(-1).id, "chat-0");
  assert.equal(snapshot.scan.unreadFiles, 0);
});

test("damaged Done state reports the local file error without replacing it", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  state.prepare("INSERT INTO threads (id,title,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, 'Chat', 0, 1, 1, 1)").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?, 1, 'completed')").run(id);
  const statePath = join(home, "done.json");
  const scanner = new CodexSessionScanner({ codexHome: home, statePath });
  assert.equal((await scanner.refresh()).healthy, true);
  for (const contents of ["malformed", JSON.stringify({ [id]: 123 })]) {
    await writeFile(statePath, contents);
    const result = await scanner.refresh();
    assert.equal(result.healthy, false);
    assert.match(result.scan.error, /local Done state file/);
    assert.doesNotMatch(result.scan.error, /Codex databases/);
    await assert.rejects(scanner.setDone(id, "turn-1", true), /local Done state file/);
    assert.equal(await readFile(statePath, "utf8"), contents);
  }
});

test("paginated history with an invalid selected filename never reads old chat-ID turns", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  state.prepare("INSERT INTO threads (id,title,archived,created_at_ms,updated_at_ms,recency_at_ms,rollout_path,history_mode) VALUES (?, 'Chat', 0, 1, 1, 1, ?, 'paginated')").run(id, join(home, "unknown.jsonl"));
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?, 1, 'interrupted')").run(id);
  const scanner = new CodexSessionScanner({ codexHome: home, statePath: join(home, "done.json") });
  for (const path of [join(home, "unknown.jsonl"), null]) {
    state.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(path, id);
    const result = await scanner.refresh();
    assert.equal(result.healthy, false);
    assert.deepEqual(result.tasks, []);
    assert.match(result.scan.error, /invalid selected rollout filename/);
    await assert.rejects(scanner.setDone(id, "turn-1", true), /invalid selected rollout filename/);
  }
  for (const [path, message] of [
    [`rollout-2026-02-31T10-00-00-${id}.jsonl`, /invalid selected rollout filename/],
    [`ROLLOUT-2026-10-07T10-00-00-${id}.jsonl`, /invalid selected rollout filename/],
    [`rollout-2026-10-07T10-00-00-${id}.JSONL`, /invalid selected rollout filename/],
    [`rollout-2026-10-07T10-00-00-${id}.jsonl.ZST`, /invalid selected rollout filename/],
    ["rollout-2026-10-07T10-00-00-01a06613-2458-7372-a1af-5159b7e39b61.jsonl", /belongs to a different chat/],
  ]) {
    state.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(join(home, path), id);
    const result = await scanner.refresh();
    assert.equal(result.healthy, false);
    assert.deepEqual(result.tasks, []);
    assert.match(result.scan.error, message);
  }
  state.prepare("UPDATE threads SET rollout_path=NULL WHERE id=?").run(id);
  // Legacy histories keep Codex's documented stable-ID lookup behavior.
  state.prepare("UPDATE threads SET history_mode='legacy' WHERE id=?").run(id);
  assert.equal((await scanner.refresh()).tasks[0].status, "interrupted");
});

test("reply excerpts belong to the selected rollout and latest turn", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now();
  const rolloutId = "0199aabb-ccdd-7eef-8abc-0123456789ac";
  state.prepare("INSERT INTO threads (id,name,cwd,created_at_ms,updated_at_ms,rollout_path,history_mode) VALUES (?,?,?,?,?,?,?)")
    .run(id, "Reply example", "/example", now, now, `rollout-2026-10-08T00-00-00-${id}_${rolloutId}.jsonl`, "paginated");
  const turn = history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,final_agent_item_id) VALUES (?,?,?,?,?)");
  turn.run(id, 99, "completed", "old", "reply");
  turn.run(rolloutId, 1, "completed", "current", "reply");
  const item = history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_json,item_type,rollout_ordinal) VALUES (?,?,?,?,?,?)");
  item.run(id, "old", "reply", JSON.stringify({type:"agentMessage",text:"Old rollout reply"}), "agentMessage", 99);
  item.run(rolloutId, "old", "reply", JSON.stringify({type:"agentMessage",text:"Wrong turn reply"}), "agentMessage", 99);
  item.run(rolloutId, "current", "reply", JSON.stringify({type:"agentMessage",text:"  PR is ready for review.  "}), "agentMessage", 1);
  const scanner = new CodexSessionScanner({codexHome:home,now:()=>now});
  assert.equal((await scanner.refresh()).tasks[0].replyExcerpt, "PR is ready for review.");
  turn.run(rolloutId, 2, "inProgress", "running", null);
  const beforeReply = await scanner.refresh();
  assert.equal(beforeReply.tasks[0].replyExcerpt, null);
  item.run(rolloutId, "running", "progress", JSON.stringify({type:"agentMessage",text:"Checking CI."}), "agentMessage", 3);
  const afterReply = await scanner.refresh();
  assert.equal(afterReply.tasks[0].replyExcerpt, "Checking CI.");
  assert.ok(afterReply.revision > beforeReply.revision);
  assert.equal(afterReply.tasks[0].updatedAt, beforeReply.tasks[0].updatedAt);
  assert.equal(afterReply.tasks[0].turnId, beforeReply.tasks[0].turnId);
  item.run(rolloutId, "running", "new-progress", JSON.stringify({type:"agentMessage",text:"x".repeat(5000)}), "agentMessage", 4);
  assert.equal((await scanner.refresh()).tasks[0].replyExcerpt.length, 2000);
  history.prepare("UPDATE thread_items SET item_json=? WHERE item_id='new-progress'").run(JSON.stringify({type:"agentMessage",text:"<heartbeat><decision>NOTIFY</decision><message>Review the PR.</message></heartbeat>"}));
  assert.equal((await scanner.refresh()).tasks[0].replyExcerpt, "Review the PR.");
  history.prepare("UPDATE thread_items SET item_json=? WHERE item_id='new-progress'").run(JSON.stringify({type:"agentMessage",text:"<heartbeat><decision>KEEP_QUIET</decision></heartbeat>"}));
  assert.equal((await scanner.refresh()).tasks[0].replyExcerpt, null);
});


test("persistent WAL readers skip unchanged queries and detect either database's commits", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  state.exec("PRAGMA journal_mode=WAL"); history.exec("PRAGMA journal_mode=WAL");
  let now = Date.now();
  state.prepare("INSERT INTO threads (id,name,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?,?,?,0,?,?,?)").run(id, "First", "/project", now, now, now);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?,1,'inProgress')").run(id);
  const scanner = new CodexSessionScanner({ codexHome: home, now: () => now, statePath: join(home, "done.json") }); t.after(() => scanner.close());
  assert.equal((await scanner.refresh()).scan.cacheHit, false);
  const idle = await scanner.refresh(); assert.equal(idle.scan.cacheHit, true);
  assert.equal((await scanner.refresh()).revision, idle.revision);
  // The writer can commit while the reader connection remains open.
  state.prepare("UPDATE threads SET name='Renamed' WHERE id=?").run(id);
  const renamed = await scanner.refresh(); assert.equal(renamed.scan.cacheHit, false); assert.equal(renamed.tasks[0].title, "Renamed");
  assert.equal((await scanner.refresh()).scan.cacheHit, true);
  now += 120_000;
  const stale = await scanner.refresh(); assert.equal(stale.scan.cacheHit, true); assert.equal(stale.tasks[0].status, "working"); assert.equal(stale.revision, renamed.revision);
  history.prepare("UPDATE thread_turns SET status='completed' WHERE thread_id=?").run(id);
  const ended = await scanner.refresh(); assert.equal(ended.scan.cacheHit, false); assert.equal(ended.tasks[0].status, "needs_input");
  assert.equal((await scanner.refresh({ force: true })).scan.cacheHit, false);
  state.prepare("DELETE FROM threads WHERE id=?").run(id);
  assert.deepEqual((await scanner.refresh()).tasks, []);
  scanner.close(); assert.equal((await scanner.refresh()).scan.cacheHit, false);
});

test("cached database records still observe schedules and local Done state on each poll", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now(); const donePath = join(home, "done.json");
  state.prepare("INSERT INTO threads (id,name,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?,?,?,0,?,?,?)").run(id, "Routine", "/project", now, now, now);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,first_user_item_id) VALUES (?,1,'completed','input')").run(id);
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_json) VALUES (?,'turn-1','input',?)").run(id, JSON.stringify({content:[{type:"text",text:"<heartbeat><automation_id>routine</automation_id></heartbeat>"}]}));
  const scanner = new CodexSessionScanner({ codexHome: home, statePath: donePath }); t.after(() => scanner.close());
  assert.equal((await scanner.refresh()).tasks[0].status, "needs_input");
  const dir = join(home, "automations", "routine"); await mkdir(dir, {recursive:true});
  const config = 'id="routine"\nkind="heartbeat"\nstatus="ACTIVE"\ntarget_thread_id="'+id+'"\n';
  await writeFile(join(dir,"automation.toml"), config);
  const scheduled = await scanner.refresh(); assert.equal(scheduled.scan.cacheHit,true); assert.equal(scheduled.tasks[0].status,"scheduled");
  await writeFile(join(dir,"automation.toml"),config.replace('ACTIVE','PAUSED'));
  assert.equal((await scanner.refresh()).tasks[0].status,"needs_input");
  await writeFile(donePath, JSON.stringify({[id]:"turn-1"}));
  const done = await scanner.refresh(); assert.equal(done.scan.cacheHit,true); assert.equal(done.tasks[0].status,"completed");
  await writeFile(donePath, "broken"); assert.equal((await scanner.refresh()).healthy,false);
  await rm(donePath); assert.equal((await scanner.refresh()).scan.cacheHit,false);
});

test("replaced or missing databases invalidate persistent connections and recover", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup; const now = Date.now();
  state.prepare("INSERT INTO threads (id,name,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?,?,?,0,?,?,?)").run(id,"Before","/project",now,now,now);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?,1,'completed')").run(id);
  const scanner = new CodexSessionScanner({codexHome:home,statePath:join(home,"done.json")}); t.after(()=>scanner.close());
  await scanner.refresh(); const path=join(home,"state_5.sqlite"); const replacement=join(home,"replacement.sqlite");
  state.exec("UPDATE threads SET name='After'; VACUUM INTO '"+replacement+"'");
  await rename(replacement,path);
  const next=await scanner.refresh(); assert.equal(next.scan.cacheHit,false); assert.equal(next.tasks[0].title,"After");
  await rename(path,replacement); const failed=await scanner.refresh(); assert.equal(failed.healthy,false); assert.deepEqual(failed.tasks,[]);
  await rename(replacement,path); assert.equal((await scanner.refresh()).healthy,true);
});


test("Done-file cache notices rewrites, replacements, removal, and invalid content", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup; const now = Date.now(); const path = join(home,"done.json");
  state.prepare("INSERT INTO threads (id,name,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?,?,?,0,?,?,?)").run(id,"Example","/project",now,now,now);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?,1,'completed')").run(id);
  const scanner = new CodexSessionScanner({codexHome:home,statePath:path}); t.after(()=>scanner.close());
  await writeFile(path,"{}");
  await scanner.refresh();
  const initialCache = scanner.doneCache; await scanner.refresh(); assert.equal(scanner.doneCache,initialCache);
  await writeFile(path,JSON.stringify({[id]:"turn-1"}));
  assert.equal((await scanner.refresh()).tasks[0].manualDone,true);
  const cached = scanner.doneCache;
  await scanner.refresh(); assert.equal(scanner.doneCache,cached);
  const info = await stat(path);
  // Same-size rewrite with restored mtime must still invalidate via ctime.
  await writeFile(path,JSON.stringify({[id]:"turn-2"})); await utimes(path,info.atime,info.mtime);
  assert.equal((await scanner.refresh()).tasks[0].manualDone,false);
  const replacement=join(home,"replacement.json"); await writeFile(replacement,JSON.stringify({[id]:"turn-1"}));
  await utimes(replacement,info.atime,info.mtime); await rename(replacement,path);
  assert.equal((await scanner.refresh()).tasks[0].manualDone,true);
  await rm(path); assert.equal((await scanner.refresh()).tasks[0].manualDone,false);
  await writeFile(path,"broken"); assert.equal((await scanner.refresh()).healthy,false);
  await writeFile(path,"{}"); assert.equal((await scanner.refresh()).healthy,true);
  const recovered=scanner.doneCache; await scanner.refresh({force:true}); assert.notEqual(scanner.doneCache,recovered);
  await scanner.setDone(id,"turn-1",true); assert.equal(scanner.task(id).manualDone,true);
});

 test("cover metadata uses full latest reply and local reads reject stale requests", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const {home,state,history} = setup;
  const image = join(home,"cover.png");
  await writeFile(image,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/kcAAAAASUVORK5CYII=","base64"));
  state.prepare("INSERT INTO threads (id,title,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, 'Cover', 0, 1, 1, 1)").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,final_agent_item_id) VALUES (?,1,'completed','cover-turn','reply')").run(id);
  const text="x".repeat(2500)+`\n![Screenshot](<${image}>)`;
  history.prepare("INSERT INTO thread_items VALUES (?,?,?,?,?,?)").run(id,"cover-turn","reply",JSON.stringify({type:"agentMessage",text}),"agentMessage",1);
  const scanner=new CodexSessionScanner({codexHome:home});t.after(()=>scanner.close());
  const first=await scanner.refresh();assert.equal(first.tasks[0].replyImage.url,image);
  assert.match(await scanner.taskImage(id,"cover-turn",image),/^data:image\/png;base64,/);
  assert.equal(await scanner.taskImage(id,"cover-turn",join(home,"other.png")),null);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id) VALUES (?,2,'inProgress','new-turn')").run(id);
  const next=await scanner.refresh();assert.equal(next.tasks[0].replyImage,null);assert.notEqual(next.revision,first.revision);
  assert.equal(await scanner.taskImage(id,"cover-turn",image),null);
 });

test("saved project names and assignments update the board revision independently of turn status", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  state.prepare("INSERT INTO projects VALUES ('saved','Workspace',0)").run();
  state.prepare("INSERT INTO project_roots VALUES ('saved','/repo',0)").run();
  state.prepare("INSERT INTO threads (id,cwd,project_id,created_at_ms,updated_at_ms) VALUES (?, '/worktree','saved',1,1)").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?,1,'completed')").run(id);
  const scanner = new CodexSessionScanner({ codexHome: home, statePath: join(home, "done.json") });
  t.after(() => scanner.close());
  const first = await scanner.refresh();
  assert.equal(first.projects[0].name, "Workspace");
  assert.equal(first.tasks[0].project.id, "saved");
  assert.equal(first.tasks[0].project.path, "/worktree");
  state.prepare("UPDATE projects SET name='Renamed' WHERE id='saved'").run();
  const renamed = await scanner.refresh();
  assert.ok(renamed.revision > first.revision);
  assert.equal(renamed.tasks[0].project.name, "Renamed");
  await writeFile(join(home, ".codex-global-state.json"), "broken");
  const failed = await scanner.refresh();
  assert.equal(failed.healthy, false);
  assert.match(failed.scan.error, /Codex project metadata/);
});

test("PR attachments come from the attachment registry and update independently of chat timestamps", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  state.exec("CREATE TABLE thread_attachments (thread_id TEXT, attachment_type TEXT, payload TEXT)");
  state.prepare("INSERT INTO threads (id,name,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, 'PR chat', '/repo', 0, 1, 1, 1)").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?,1,'completed')").run(id);
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_type,item_json) VALUES (?,'turn-1','reply','agentMessage',?)").run(id, JSON.stringify({type:'agentMessage',text:'https://github.com/example/repo/pull/12'}));
  const scanner = new CodexSessionScanner({ codexHome: home }); t.after(() => scanner.close());
  const first = await scanner.refresh(); assert.deepEqual(first.tasks[0].pullRequests, []);
  const url = "https://github.com/example/repo/pull/12";
  state.prepare("INSERT INTO thread_attachments VALUES (?, 'pull_request', ?)").run(id, JSON.stringify({ url }));
  state.prepare("INSERT INTO thread_attachments VALUES (?, 'worktree', ?)").run(id, JSON.stringify({ root: "/repo" }));
  const next = await scanner.refresh();
  assert.ok(next.revision > first.revision);
  assert.deepEqual(next.tasks[0].pullRequests, [{ url, state: "unknown", checks: "unknown" }]);
  state.exec("DELETE FROM thread_attachments WHERE attachment_type='pull_request'");
  assert.deepEqual((await scanner.refresh()).tasks[0].pullRequests, []);
});

test("a newly attached PR rejects manual Done and suppresses an older manual mark", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  state.exec("CREATE TABLE thread_attachments (thread_id TEXT, attachment_type TEXT, payload TEXT)");
  state.prepare("INSERT INTO threads (id,name,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, 'PR chat', '/repo', 0, 1, 1, 1)").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?,1,'completed')").run(id);
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_type,item_json) VALUES (?,'turn-1','reply','agentMessage',?)").run(id, JSON.stringify({type:'agentMessage',text:'https://github.com/example/repo/pull/12'}));
  const statePath = join(home, "done.json");
  const scanner = new CodexSessionScanner({ codexHome: home, statePath }); t.after(() => scanner.close());
  await scanner.setDone(id, "turn-1", true);
  assert.equal(scanner.task(id).manualDone, true);
  state.prepare("INSERT INTO thread_attachments VALUES (?, 'pull_request', ?)").run(id, JSON.stringify({ url: "https://github.com/example/repo/pull/12" }));
  await assert.rejects(() => scanner.setDone(id, "turn-1", true), /attached PRs/);
  assert.equal(scanner.task(id).manualDone, false);
  assert.equal(scanner.task(id).status, "needs_input");
});

test("active schedules block new and existing Done marks until every schedule is paused", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  state.prepare("INSERT INTO threads (id,title,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, 'Chat',0,1,1,1)").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id) VALUES (?,1,'completed','turn-1')").run(id);
  const scanner = new CodexSessionScanner({ codexHome: home, statePath: join(home, "done.json") });
  t.after(() => scanner.close());
  await scanner.setDone(id, "turn-1", true);
  for (const name of ["one", "two"]) {
    await mkdir(join(home, "automations", name), { recursive: true });
    await writeFile(join(home, "automations", name, "automation.toml"), `id = "${name}"\nkind = "heartbeat"\nstatus = "ACTIVE"\ntarget_thread_id = "${id}"\n`);
  }
  await scanner.refresh();
  assert.equal(scanner.task(id).manualDone, false);
  assert.equal(scanner.task(id).status, "needs_input");
  await assert.rejects(scanner.setDone(id, "turn-1", true), /Pause all active schedules/);
  await writeFile(join(home, "automations", "one", "automation.toml"), `id = "one"\nkind = "heartbeat"\nstatus = "PAUSED"\ntarget_thread_id = "${id}"\n`);
  await assert.rejects(scanner.setDone(id, "turn-1", true), /Pause all active schedules/);
  await writeFile(join(home, "automations", "two", "automation.toml"), `id = "two"\nkind = "heartbeat"\nstatus = "PAUSED"\ntarget_thread_id = "${id}"\n`);
  await scanner.setDone(id, "turn-1", true);
  assert.equal(scanner.task(id).status, "completed");
});


test("latest-turn PRs require both registered ownership and a current-turn reference", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const {home,state,history}=setup;
  state.exec("CREATE TABLE thread_attachments (thread_id TEXT, attachment_type TEXT, payload TEXT)");
  state.prepare("INSERT INTO threads (id,name,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, 'PR scope',0,1,1,1)").run(id);
  const oldUrl="https://github.com/example/repo/pull/12", currentUrl="https://github.com/example/repo/pull/123";
  for(const url of [oldUrl,currentUrl])state.prepare("INSERT INTO thread_attachments VALUES (?,'pull_request',?)").run(id,JSON.stringify({url}));
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id) VALUES (?,1,'completed','old'), (?,2,'completed','new')").run(id,id);
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_type,item_json) VALUES (?,'old','reply','agentMessage',?), (?,'new','reply','agentMessage',?)").run(id,JSON.stringify({type:"agentMessage",text:oldUrl}),id,JSON.stringify({type:"agentMessage",text:`${currentUrl}/ https://github.com/example/repo/pull/999`}));
  const scanner=new CodexSessionScanner({codexHome:home,statePath:join(home,'done.json')});t.after(()=>scanner.close());
  assert.deepEqual((await scanner.refresh()).tasks[0].pullRequests.map(x=>x.url),[currentUrl]);
  history.prepare("UPDATE thread_items SET item_json=? WHERE turn_id='new'").run(JSON.stringify({type:"agentMessage",text:"No PR mentioned."}));
  assert.deepEqual((await scanner.refresh()).tasks[0].pullRequests,[]);
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_type,item_json) VALUES (?,'new','attach','mcpToolCall',?)").run(id,JSON.stringify({server:'codex_app',tool:'attach_artifact',status:'completed',arguments:{artifact_type:'pull_request',url:currentUrl}}));
  assert.deepEqual((await scanner.refresh()).tasks[0].pullRequests.map(x=>x.url),[currentUrl]);
  history.prepare("UPDATE thread_items SET item_json=? WHERE item_id='attach'").run(JSON.stringify({server:'codex_app',tool:'attach_artifact',status:'failed',error:{message:'failed'},arguments:{artifact_type:'pull_request',url:currentUrl}}));
  assert.deepEqual((await scanner.refresh()).tasks[0].pullRequests,[]);
});


test("Running overrides a saved Done mark when the selected turn resumes", async (t) => {
  const setup=await fixture(t);if(!setup)return;
  const {home,state,history}=setup;
  state.prepare("INSERT INTO threads (id,name,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, 'Resume',0,1,1,1)").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id) VALUES (?,1,'completed','same-turn')").run(id);
  const scanner=new CodexSessionScanner({codexHome:home,statePath:join(home,'done.json')});t.after(()=>scanner.close());
  await scanner.setDone(id,'same-turn',true);
  history.exec("UPDATE thread_turns SET status='inProgress'");
  const running=(await scanner.refresh()).tasks[0];
  assert.equal(running.status,'working');assert.equal(running.manualDone,false);
});

test("schedule clock reads nominal next run and notices scheduler changes without chat writes", async t => {
  const f=await fixture(t); if(!f)return;
  f.state.prepare("INSERT INTO threads (id,name,cwd,archived,created_at_ms,updated_at_ms,recency_at_ms) VALUES (?, 'Scheduled demo', '/repo', 0, 1, 1, 1)").run(id);
  f.history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status) VALUES (?,1,'completed')").run(id);
  await mkdir(join(f.home,"automations","demo"),{recursive:true});
  await writeFile(join(f.home,"automations","demo","automation.toml"),`id = "demo"\nkind = "heartbeat"\nstatus = "ACTIVE"\ntarget_thread_id = "${id}"\n`);
  const scanner=new CodexSessionScanner({codexHome:f.home}); t.after(()=>scanner.close());
  const missing=await scanner.refresh();
  assert.equal(missing.tasks[0].scheduled,true); assert.equal(missing.tasks[0].nextRunAt,null);
  await mkdir(join(f.home,"sqlite"));
  const {DatabaseSync}=await import("node:sqlite");
  const runtime=new DatabaseSync(join(f.home,"sqlite","codex-dev.db")); t.after(()=>runtime.close());
  runtime.exec("CREATE TABLE automations (id TEXT, target_thread_id TEXT, kind TEXT, status TEXT, next_run_at INTEGER, next_run_nominal_at INTEGER)");
  runtime.prepare("INSERT INTO automations VALUES ('demo',?,'heartbeat','ACTIVE',200000,180000)").run(id);
  const first=await scanner.refresh(); assert.equal(first.tasks[0].nextRunAt,new Date(180000).toISOString());
  runtime.exec("UPDATE automations SET next_run_nominal_at=240000");
  const updated=await scanner.refresh(); assert.ok(updated.revision>first.revision);
  assert.equal(updated.tasks[0].nextRunAt,new Date(240000).toISOString());
  runtime.exec("UPDATE automations SET next_run_at=NULL");
  assert.equal((await scanner.refresh()).tasks[0].nextRunAt,null);
  runtime.exec("UPDATE automations SET next_run_at=300000, next_run_nominal_at=NULL");
  assert.equal((await scanner.refresh()).tasks[0].nextRunAt,new Date(300000).toISOString());
});


test("returning a human turn to Scheduled persists only for that turn", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  state.prepare("INSERT INTO threads (id,name,archived,created_at_ms,updated_at_ms) VALUES (?,'Scheduled chat',0,1,1)").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,first_user_item_id) VALUES (?,1,'completed','turn-1','input')").run(id);
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_json) VALUES (?,'turn-1','input',?)").run(id, JSON.stringify({content:[{type:'text',text:'Discuss this'}],clientId:'human'}));
  await mkdir(join(home,'automations','routine'),{recursive:true});
  const schedule = join(home,'automations','routine','automation.toml');
  await writeFile(schedule, `id = "routine"\nkind = "heartbeat"\nstatus = "ACTIVE"\ntarget_thread_id = "${id}"\n`);
  const scanner = new CodexSessionScanner({codexHome:home,statePath:join(home,'done.json')}); t.after(()=>scanner.close());
  assert.equal((await scanner.setScheduled(id,'turn-1')).status,'scheduled');
  await assert.rejects(scanner.setScheduled(id,'old-turn'), /Chat changed/);
  history.prepare("UPDATE thread_turns SET status='inProgress'").run();
  await assert.rejects(scanner.setScheduled(id,'turn-1'), /in-progress/);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,first_user_item_id) VALUES (?,2,'completed','turn-2','input')").run(id);
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_json) VALUES (?,'turn-2','input',?)").run(id,JSON.stringify({content:[{type:'text',text:'New question'}],clientId:'human'}));
  assert.equal((await scanner.refresh()).tasks[0].status,'needs_input');
  await writeFile(schedule, `id = "routine"\nkind = "heartbeat"\nstatus = "PAUSED"\ntarget_thread_id = "${id}"\n`);
  await assert.rejects(scanner.setScheduled(id,'turn-2'), /active schedule/);
});


test("an Interrupted turn can be marked Done only with confirmed current PRs", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  state.exec("CREATE TABLE thread_attachments (thread_id TEXT, attachment_type TEXT, payload TEXT)");
  state.prepare("INSERT INTO threads (id,name,archived,created_at_ms,updated_at_ms) VALUES (?,'Interrupted PR chat',0,1,1)").run(id);
  history.prepare("INSERT INTO thread_turns (thread_id,rollout_ordinal,status,turn_id,final_agent_item_id) VALUES (?,1,'interrupted','turn-1','reply')").run(id);
  const urls=['https://github.com/example/repo/pull/12','https://github.com/example/repo/pull/13'];
  history.prepare("INSERT INTO thread_items (thread_id,turn_id,item_id,item_json) VALUES (?,'turn-1','reply',?)").run(id,JSON.stringify({type:'agentMessage',text:urls.join(' ')}));
  const insert=state.prepare("INSERT INTO thread_attachments VALUES (?,'pull_request',?)");
  insert.run(id,JSON.stringify({url:urls[0]}));
  const scanner=new CodexSessionScanner({codexHome:home,statePath:join(home,'done.json')});t.after(()=>scanner.close());
  await assert.rejects(scanner.setDone(id,'turn-1',true), /confirmed merge/);
  assert.equal((await scanner.setDone(id,'turn-1',true,[urls[0]])).status,'completed');
  insert.run(id,JSON.stringify({url:urls[1]}));
  assert.equal((await scanner.refresh()).tasks[0].status,'interrupted');
  await assert.rejects(scanner.setDone(id,'turn-1',true,[urls[0]]), /confirmed merge/);
});
