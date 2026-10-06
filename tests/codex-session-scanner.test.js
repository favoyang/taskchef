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
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, archived INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER, rollout_path TEXT, thread_source TEXT)");
  state.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT, PRIMARY KEY (parent_thread_id, child_thread_id))");
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT)");
  t.after(() => { state.close(); history.close(); });
  return { home, state, history };
}

test("database is the sole inventory and status source", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now();
  const rolloutPath = join(home, "selected.jsonl");
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, null, "Private title", "/example/project", 0, now, now, now, rolloutPath, "user");
  history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?)").run(id, 1, "inProgress");
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
  history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?)").run(id, 2, "failed");
  const next = await scanner.refresh();
  assert.equal(next.tasks[0].status, null);
  assert.equal(next.tasks[0].observed.lastTurnEvent, "failed");
});

test("chat name takes precedence over title, with title and ID fallbacks", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state } = setup;
  const now = Date.now();
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, "TaskChef Next storage demo", "Old title", "/example/project", 0, now, now, now, null, "user");
  const scanner = new CodexSessionScanner({ codexHome: home });
  assert.equal((await scanner.refresh()).tasks[0].title, "TaskChef Next storage demo");
  state.prepare("UPDATE threads SET name = ? WHERE id = ?").run("  ", id);
  assert.equal((await scanner.refresh()).tasks[0].title, "Old title");
  state.prepare("UPDATE threads SET title = ? WHERE id = ?").run("", id);
  assert.equal((await scanner.refresh()).tasks[0].title, `Codex chat ${id.slice(0, 8)}`);
});

test("inventory excludes child chats and Guardian reviews but shows direct child counts on parents", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state } = setup;
  const now = Date.now();
  const insert = state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const parent = "parent";
  insert.run(parent, "Parent", "", "/example/project", 0, now, now, now - 2, null, "user");
  insert.run("other", "Other", "", "/example/project", 0, now, now, now - 1, null, null);
  insert.run("older", "Older", "", "/example/project", 0, now, now, now - 3, null, "automation");
  insert.run("child", "Child", "", "/example/project", 0, now, now, now + 2, null, "subagent");
  insert.run("legacy-child", "Legacy child", "", "/example/project", 0, now, now, now + 3, null, null);
  insert.run("guardian", "Guardian review", "", "/example/project", 0, now, now, now + 1, null, "guardian_review");
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run(parent, "child", "open");
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run(parent, "legacy-child", "open");
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
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, null, "Title", "/example/project", 0, now, now, now, null, "user");
  const scanner = new CodexSessionScanner({ codexHome: home });
  assert.equal((await scanner.refresh()).tasks.length, 1);
  history.exec("DROP TABLE thread_turns");
  const failed = await scanner.refresh();
  assert.equal(failed.healthy, false);
  assert.equal(failed.scan.mode, "error");
  assert.deepEqual(failed.tasks, []);
  assert.equal(scanner.task(id), undefined);
  assert.equal(await scanner.taskDetail(id), null);
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT)");
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
