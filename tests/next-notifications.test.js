import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextNotifications } from "../src/next-notifications.js";
const settings = { showExec: false, showCli: false };
const task = (status = "working", turnId = "t1", extra = {}) => ({ id: "chat", title: "Fix login", status, turnId, inputSource: "ordinary", ...extra });
async function setup(t) { const dir = await mkdtemp(join(tmpdir(), "next-notices-")); t.after(() => rm(dir, { recursive: true, force: true })); const path = join(dir, "notifications.json"); return { path, store: new NextNotifications(path) }; }
const reconcile = (store, tasks, prefs = settings) => store.reconcile(async () => ({ healthy: true, tasks }), prefs).then((result) => result.notifications);

test("baseline stays quiet; new turns notify once; read and clear survive restart", async (t) => {
  const { path, store } = await setup(t);
  assert.deepEqual((await reconcile(store, [task("needs_input")])).items, []);
  await reconcile(store, [task("working", "t2")]);
  const ready = await reconcile(store, [task("needs_input", "t2")]);
  assert.equal(ready.items.length, 1);
  assert.equal(ready.items[0].title, "Fix login is ready for input or review");
  assert.equal(ready.items[0].read, false);
  assert.deepEqual(await reconcile(new NextNotifications(path), [task("needs_input", "t2")]), ready);
  const read = await store.action({ action: "read", id: ready.items[0].id });
  assert.equal(read.items[0].read, true);
  assert.ok(read.revision > ready.revision);
  await store.action({ action: "clear" });
  assert.equal((await reconcile(new NextNotifications(path), [task("needs_input", "t2")])).items.length, 0);
  const interrupted = await reconcile(store, [task("interrupted", "t2")]);
  assert.equal(interrupted.items[0].kind, "interrupted");
  await reconcile(store, [task("working", "t2")]);
  assert.equal((await reconcile(store, [task("interrupted", "t2")])).items.length, 1);
});

test("scheduled completions, archived and hidden sources stay quiet; scheduled failures notify", async (t) => {
  const { store } = await setup(t);
  await reconcile(store, [task()]);
  assert.equal((await reconcile(store, [task("scheduled", "t1", { scheduled: true })])).items.length, 0);
  const failed = await reconcile(store, [task("interrupted", "t2", { scheduled: true })]);
  assert.equal(failed.items.length, 1);
  await reconcile(store, [task("needs_input", "t3", { observed: { source: "exec" } })]);
  assert.equal((await reconcile(store, [task("needs_input", "t3", { observed: { source: "exec" } })], { ...settings, showExec: true })).items.length, 1);
  assert.equal((await reconcile(store, [task("needs_input", "t4", { observed: { archive: true } })])).items.length, 1);
  assert.equal((await reconcile(store, [task("needs_input", "t5", { observed: { source: "cli" } })])).items.length, 1);
  assert.equal((await reconcile(store, [task("completed", "t6", { manualDone: true })])).items.length, 1);
});

test("shared clients reconcile once and preserve concurrent actions", async (t) => {
  const { path, store } = await setup(t);
  const other = new NextNotifications(path);
  await reconcile(store, [task()]);
  await Promise.all([reconcile(store, [task("needs_input")]), reconcile(other, [task("needs_input")])]);
  await Promise.all([store.confirmation(task()), other.action({ action: "error", operation: "open", task: task(), error: "Network error" })]);
  const state = JSON.parse(await readFile(path, "utf8"));
  assert.equal(state.items.length, 3);
  assert.equal(state.items.find((item) => item.kind === "confirmation").read, true);
  assert.equal(state.items.find((item) => item.kind === "error").detail, "Network error");
  assert.ok((await other.action({ action: "read_all" })).items.every((item) => item.read));
});

test("database failures do not erase baseline; corrupt notification files are preserved", async (t) => {
  const { path, store } = await setup(t);
  await reconcile(store, [task()]);
  await store.reconcile(async () => ({ healthy: false, tasks: [] }), settings);
  assert.equal((await reconcile(store, [task("needs_input")])).items.length, 1);
  await writeFile(path, '{"broken":true}');
  await assert.rejects(reconcile(store, []), /cannot read notifications.json/);
  assert.equal(await readFile(path, "utf8"), '{"broken":true}');
});

test("history is bounded; consumed turn events survive clear", async (t) => {
  const { store } = await setup(t);
  await reconcile(store, [task()]);
  for (let index = 0; index < 105; index++) await store.confirmation(task());
  assert.equal((await reconcile(store, [task()])).items.length, 100);
});


test("paused, missing and unreadable heartbeat schedules do not create ready notices", async (t) => {
  const { store } = await setup(t);
  await reconcile(store, [task()]);
  for (const inputSource of ["scheduled", "unverified"]) {
    const turn = `heartbeat-${inputSource}`;
    await reconcile(store, [task("working", turn, { inputSource, scheduled: false })]);
    assert.equal((await reconcile(store, [task("needs_input", turn, { inputSource, scheduled: false })])).items.length, 0);
  }
  assert.equal((await reconcile(store, [task("needs_input", "human", { inputSource: "ordinary", scheduled: true })])).items.length, 1);
});


test("unarchiving a saved terminal turn does not replay its notification", async (t) => {
  const { store } = await setup(t);
  for (const [terminal, visible] of [["completed", "needs_input"], ["failed", "interrupted"], ["interrupted", "interrupted"]]) {
    const turn = `archived-${terminal}`;
    await reconcile(store, [task("archived", turn, { observed: { archive: true, lastTurnEvent: terminal } })]);
    assert.equal((await reconcile(store, [task(visible, turn, { observed: { archive: false, lastTurnEvent: terminal } })])).items.length, 0);
  }
  await reconcile(store, [task("archived", "active", { observed: { archive: true, lastTurnEvent: "inProgress" } })]);
  await reconcile(store, [task("working", "active", { observed: { archive: false, lastTurnEvent: "inProgress" } })]);
  assert.equal((await reconcile(store, [task("needs_input", "active", { observed: { archive: false, lastTurnEvent: "completed" } })])).items.length, 1);
});
