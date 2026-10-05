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
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, archived INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER, rollout_path TEXT)");
  history.exec("CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT)");
  t.after(() => { state.close(); history.close(); });
  return { home, state, history };
}

test("database is the sole inventory and status source", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now();
  const rolloutPath = join(home, "selected.jsonl");
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, "Private title", "/example/project", 0, now, now, now, rolloutPath);
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

test("missing or incompatible databases are fatal and clear prior inventory", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  const { home, state, history } = setup;
  const now = Date.now();
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, "Title", "/example/project", 0, now, now, now, null);
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
  for (const nodeVersion of ["18.20.8", "22.17.9"]) {
    const result = await new CodexSessionScanner({ codexHome: home, nodeVersion }).refresh();
    assert.equal(result.healthy, false);
    assert.deepEqual(result.tasks, []);
    assert.match(result.scan.error, /TaskChef Next requires Node\.js 22\.18\.0 or later for read-only SQLite/);
    assert.ok(result.scan.error.includes(nodeVersion));
  }
  assert.deepEqual(await readdir(home), []);
});

test("Node 22.18 and later majors permit read-only database scans", async (t) => {
  const setup = await fixture(t); if (!setup) return;
  for (const nodeVersion of ["22.18.0", "23.0.0"]) {
    const result = await new CodexSessionScanner({ codexHome: setup.home, nodeVersion }).refresh();
    assert.equal(result.healthy, true);
  }
});
