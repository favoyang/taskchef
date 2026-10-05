import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, chmod, rename, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionScanner } from "../src/codex-session-scanner.js";

const id = "0199aabb-ccdd-7eef-8abc-0123456789ab";
const line = (type, payload) => JSON.stringify({ type, timestamp: "2026-10-05T00:00:00Z", payload }) + "\n";
const fileName = `rollout-2026-10-05T00-00-00-${id}.jsonl`;

test("reads indexed database metadata on each request without parsing rollout text", async (t) => {
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite?.DatabaseSync) return t.skip("node:sqlite is unavailable");
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-db-"));
  let now = Date.now();
  try {
    const state = new sqlite.DatabaseSync(join(home, "state_5.sqlite"));
    const history = new sqlite.DatabaseSync(join(home, "thread_history_1.sqlite"));
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, archived INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER, recency_at_ms INTEGER); CREATE INDEX recent_threads ON threads(recency_at_ms DESC)");
    history.exec("CREATE TABLE thread_turns (thread_id TEXT, rollout_ordinal INTEGER, status TEXT); CREATE INDEX recent_turns ON thread_turns(thread_id, rollout_ordinal DESC)");
    const insert = state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run(id, "Private user title", "/example/project", 0, now - 1000, now - 1000, now - 1000);
    const older = "0199aabb-ccdd-7eef-8abc-0123456789ac";
    insert.run(older, "Older", "/example/older", 1, now - 5000, now - 5000, now - 5000);
    history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?)").run(id, 1, "completed");
    history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?)").run(id, 2, "inProgress");
    const scanner = new CodexSessionScanner({ codexHome: home, now: () => now, fileLimit: 1 });
    const first = await scanner.refresh();
    assert.equal(first.scan.source, "database");
    assert.equal(first.scan.indexedFiles, 2);
    assert.equal(first.scan.unreadFiles, 1);
    assert.equal(first.tasks[0].title, "Private user title");
    assert.equal(first.tasks[0].status, "working");
    assert.equal(first.tasks[0].observed.lastTurnEvent, "inProgress");
    assert.doesNotMatch(JSON.stringify(first), /item_json|transcript/);
    history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?)").run(id, 3, "failed");
    now += 1000;
    const next = await scanner.refresh();
    assert.equal(next.tasks[0].status, null);
    assert.equal(next.tasks[0].observed.lastTurnEvent, "failed");
    assert.ok(next.revision > first.revision);
    history.close(); state.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("falls back to rollout files when database schema is incompatible", async (t) => {
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite?.DatabaseSync) return t.skip("node:sqlite is unavailable");
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-db-"));
  try {
    const state = new sqlite.DatabaseSync(join(home, "state_5.sqlite"));
    state.exec("CREATE TABLE incompatible (id TEXT)");
    state.close();
    const sessions = join(home, "sessions");
    await mkdir(sessions);
    await writeFile(join(sessions, fileName), line("session_meta", { id, cwd: "/example/project" }));
    const result = await new CodexSessionScanner({ codexHome: home }).refresh();
    assert.equal(result.scan.source, "rollout files");
    assert.equal(result.tasks[0].id, id);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("inventories local sessions, updates changed logs, and tracks archive moves without exposing message text", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  let now = Date.now();
  try {
    const active = join(home, "sessions", "2026", "10", "05");
    const archived = join(home, "archived_sessions");
    await mkdir(active, { recursive: true });
    await mkdir(archived);
    const path = join(active, fileName);
    await writeFile(path, line("session_meta", { id, cwd: "/example/project", timestamp: "2026-10-05T00:00:00Z" })
      + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "private request" }] })
      + line("event_msg", { type: "task_started" }));
    const scanner = new CodexSessionScanner({ codexHome: home, now: () => now, scanIntervalMs: 10, fullIntervalMs: 1_000_000 });
    const first = await scanner.refresh();
    assert.equal(first.scan.mode, "full");
    assert.equal(first.scan.indexedFiles, 1);
    assert.equal(first.scan.activeFiles, 1);
    assert.equal(first.tasks[0].project.name, "project");
    assert.equal(first.tasks[0].status, "working");
    assert.doesNotMatch(JSON.stringify(first), /private request/);
    now += 121_000;
    const aged = await scanner.refresh();
    assert.equal(aged.scan.parsedFiles, 0);
    assert.equal(aged.tasks[0].status, null);
    assert.ok(aged.revision > first.revision);
    now += 20;
    await appendFile(path, line("event_msg", { type: "task_complete" }) + "{partial");
    const second = await scanner.refresh();
    assert.equal(second.scan.mode, "incremental");
    assert.equal(second.scan.parsedFiles, 1);
    assert.equal(second.tasks[0].status, null);
    assert.equal(second.tasks[0].observed.lastTurnEvent, "task_complete");
    now += 20;
    const third = await scanner.refresh();
    assert.equal(third.scan.parsedFiles, 0);
    await rename(path, join(archived, fileName));
    now += 20;
    const moved = await scanner.refresh();
    assert.equal(moved.scan.archivedFiles, 1);
    assert.equal(moved.tasks[0].observed.archive, true);
    now += 1_000_001;
    assert.equal((await scanner.refresh()).scan.mode, "full");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("forced refresh during a pending scan reads changes and coalesces overlapping requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  try {
    const sessions = join(home, "sessions");
    await mkdir(sessions);
    const path = join(sessions, fileName);
    await writeFile(path, line("session_meta", { id, cwd: "/example/project" }) + line("event_msg", { type: "task_started" }));
    const scanner = new CodexSessionScanner({ codexHome: home });
    const scan = scanner.scan.bind(scanner);
    let releaseFirst;
    let firstScanned;
    const firstScannedPromise = new Promise((resolve) => { firstScanned = resolve; });
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let scans = 0;
    scanner.scan = async (now) => {
      const result = await scan(now);
      scans += 1;
      if (scans === 1) {
        firstScanned();
        await firstGate;
      }
      return result;
    };

    const initial = scanner.refresh();
    await firstScannedPromise;
    await appendFile(path, line("event_msg", { type: "task_complete" }));
    const forced = scanner.refresh({ force: true });
    const repeated = scanner.refresh({ force: true });
    releaseFirst();
    assert.equal((await initial).tasks[0].observed.lastTurnEvent, "task_started");
    for (const result of await Promise.all([forced, repeated])) {
      assert.equal(result.tasks[0].observed.lastTurnEvent, "task_complete");
    }
    assert.equal(scans, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("empty Codex home and malformed rollout are safe", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  try {
    const scanner = new CodexSessionScanner({ codexHome: home });
    assert.equal((await scanner.refresh()).tasks.length, 0);
    const path = join(home, "archived_sessions");
    await mkdir(path);
    await writeFile(join(path, fileName), "{bad line\n");
    const result = await scanner.refresh({ force: true });
    assert.equal(result.tasks.length, 0);
    assert.equal(result.scan.errors, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("rejects invalid metadata and complete malformed records", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  const sessions = join(home, "sessions");
  try {
    await mkdir(sessions);
    const path = join(sessions, fileName);
    const scanner = new CodexSessionScanner({ codexHome: home });
    await writeFile(path, line("session_meta", { id: "different", cwd: "/example/project" }));
    assert.equal((await scanner.refresh()).scan.errors, 1);
    await writeFile(path, line("session_meta", { id, cwd: "/example/project" }) + "{bad line\n");
    const result = await scanner.refresh({ force: true });
    assert.equal(result.tasks.length, 0);
    assert.equal(result.scan.errors, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("does not report working from a cached start when a changed log cannot be parsed", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  const sessions = join(home, "sessions");
  let now = Date.now();
  try {
    await mkdir(sessions);
    const path = join(sessions, fileName);
    await writeFile(path, line("session_meta", { id, cwd: "/example/project" }) + line("event_msg", { type: "task_started" }));
    const scanner = new CodexSessionScanner({ codexHome: home, now: () => now, scanIntervalMs: 10, fullIntervalMs: 1_000_000 });
    assert.equal((await scanner.refresh()).tasks[0].status, "working");

    await appendFile(path, "{bad line\n");
    now += 10;
    const failed = await scanner.refresh();
    assert.equal(failed.scan.errors, 1);
    assert.equal(failed.tasks[0].status, null);
    assert.match(failed.tasks[0].summary, /unknown/);

    await writeFile(path, line("session_meta", { id, cwd: "/example/project" }) + line("event_msg", { type: "task_complete" }));
    now += 10;
    const recovered = await scanner.refresh();
    assert.equal(recovered.scan.parsedFiles, 1);
    assert.equal(recovered.tasks[0].observed.lastTurnEvent, "task_complete");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("failed scan remains unhealthy during throttling and recovers after a successful scan", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  let now = 1_000;
  try {
    const scanner = new CodexSessionScanner({ codexHome: home, now: () => now });
    assert.equal((await scanner.refresh()).healthy, true);
    await writeFile(join(home, "sessions"), "not a directory");
    now += 30_000;
    assert.equal((await scanner.refresh()).healthy, false);
    assert.equal((await scanner.refresh()).healthy, false);
    await rm(join(home, "sessions"));
    assert.equal((await scanner.refresh({ force: true })).healthy, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("retries a changed log after a read failure on the next incremental scan", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  const sessions = join(home, "sessions");
  const path = join(sessions, fileName);
  let now = 1_000;
  try {
    await mkdir(sessions);
    await writeFile(path, line("session_meta", { id, cwd: "/example/project" }) + line("event_msg", { type: "task_started" }));
    const scanner = new CodexSessionScanner({ codexHome: home, now: () => now, scanIntervalMs: 10, fullIntervalMs: 1_000_000 });
    assert.equal((await scanner.refresh()).tasks[0].observed.lastTurnEvent, "task_started");
    await appendFile(path, line("event_msg", { type: "task_complete" }));
    await chmod(path, 0o000);
    now += 10;
    const failed = await scanner.refresh();
    assert.equal(failed.scan.errors, 1);
    assert.equal(failed.tasks[0].observed.lastTurnEvent, "task_started");
    await chmod(path, 0o600);
    now += 10;
    const recovered = await scanner.refresh();
    assert.equal(recovered.scan.mode, "incremental");
    assert.equal(recovered.scan.parsedFiles, 1);
    assert.equal(recovered.tasks[0].observed.lastTurnEvent, "task_complete");
  } finally {
    await chmod(path, 0o600).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

test("parses a record crossing the head boundary when the sample covers the whole file", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  try {
    const sessions = join(home, "sessions");
    await mkdir(sessions);
    await writeFile(join(sessions, fileName), line("session_meta", {
      id, cwd: "/example/project", padding: "x".repeat(32 * 1024),
    }) + line("event_msg", { type: "task_complete" }));
    const result = await new CodexSessionScanner({ codexHome: home }).refresh();
    assert.equal(result.tasks[0].project.name, "project");
    assert.equal(result.tasks[0].observed.lastTurnEvent, "task_complete");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("reads a long first metadata line when the middle of the log is unsampled", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  try {
    const sessions = join(home, "sessions");
    await mkdir(sessions);
    await writeFile(join(sessions, fileName), line("session_meta", {
      id, cwd: "/example/large-project", timestamp: "2026-01-02T03:04:05Z", padding: "x".repeat(40 * 1024),
    }) + line("other", { padding: "y".repeat(2 * 1024 * 1024) }) + line("event_msg", { type: "task_complete" }));
    const result = await new CodexSessionScanner({ codexHome: home }).refresh();
    assert.equal(result.tasks[0].project.name, "large-project");
    assert.equal(result.tasks[0].createdAt, "2026-01-02T03:04:05Z");
    assert.equal(result.tasks[0].observed.lastTurnEvent, "task_complete");
    assert.equal(result.tasks[0].observed.sampledBytes, 1024 * 1024 + 256 * 1024);
    assert.ok(result.tasks[0].observed.sampledBytes < result.tasks[0].observed.fileBytes);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("does not infer an active turn from a head event across an unsampled gap", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  let now = Date.now();
  try {
    const sessions = join(home, "sessions");
    await mkdir(sessions);
    await writeFile(join(sessions, fileName), line("session_meta", { id, cwd: "/example/project" })
      + line("event_msg", { type: "task_started" })
      + line("other", { padding: "x".repeat(1024 * 1024) })
      + line("event_msg", { type: "task_complete" })
      + line("other", { padding: "y".repeat(1024 * 1024) })
      + line("other", { note: "tail contains no turn event" }));
    const scanner = new CodexSessionScanner({ codexHome: home, now: () => now, scanIntervalMs: 10, fullIntervalMs: 1_000_000 });
    const first = await scanner.refresh();
    assert.equal(first.tasks[0].status, null);
    assert.equal(first.tasks[0].observed.lastTurnEvent, null);
    assert.equal(first.tasks[0].observed.recentFileActivity, true);
    assert.match(first.tasks[0].summary, /Recent log file activity observed; current turn and task outcome are unknown/);
    now += 10;
    const reused = await scanner.refresh();
    assert.equal(reused.scan.parsedFiles, 0);
    assert.equal(reused.tasks[0].status, null);
    assert.equal(reused.tasks[0].observed.lastTurnEvent, null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("reports a recent append without inferring a turn across an unsampled gap", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskchef-next-"));
  let now = Date.now();
  try {
    const sessions = join(home, "sessions");
    await mkdir(sessions);
    const path = join(sessions, fileName);
    await writeFile(path, line("session_meta", { id, cwd: "/example/project" })
      + line("event_msg", { type: "task_started" })
      + line("other", { padding: "x".repeat(1024 * 1024) })
      + line("other", { note: "tail contains no turn event" }));
    const scanner = new CodexSessionScanner({ codexHome: home, now: () => now, scanIntervalMs: 10, fullIntervalMs: 1_000_000 });
    const first = await scanner.refresh();
    assert.equal(first.tasks[0].status, null);
    assert.equal(first.tasks[0].observed.lastTurnEvent, null);

    now += 121_000;
    const aged = await scanner.refresh();
    assert.equal(aged.tasks[0].observed.recentFileActivity, false);
    assert.doesNotMatch(aged.tasks[0].summary, /Recent log file activity/);

    await appendFile(path, line("other", { note: "new output without a turn event" }));
    now += 10;
    await utimes(path, new Date(now), new Date(now));
    const appended = await scanner.refresh();
    assert.equal(appended.scan.parsedFiles, 1);
    assert.equal(appended.tasks[0].status, null);
    assert.equal(appended.tasks[0].observed.lastTurnEvent, null);
    assert.equal(appended.tasks[0].observed.recentFileActivity, true);
    assert.match(appended.tasks[0].summary, /Recent log file activity observed; current turn and task outcome are unknown/);
    assert.ok(appended.revision > aged.revision);
  } finally { await rm(home, { recursive: true, force: true }); }
});
