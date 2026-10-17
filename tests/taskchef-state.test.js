import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { taskChefStateDir, taskChefStatePaths } from "../src/taskchef-state.js";
import { migrateTaskChefState, assertNoStateWriters } from "../scripts/migrate-taskchef-state.js";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "taskchef-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, ...taskChefStatePaths(home) };
}
const offline = { assertStopped: async () => {} };
async function file(path, value = "preserve me") {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
}
async function inventory(root, directory = root) {
  const result = {};
  for (const name of await readdir(directory)) {
    const path = join(directory, name), stat = await lstat(path);
    result[relative(root, path)] = { mode: stat.mode & 0o777, ...(stat.isDirectory() ? { directory: true } : { sha256: createHash("sha256").update(await readFile(path)).digest("hex") }) };
    if (stat.isDirectory()) Object.assign(result, await inventory(root, path));
  }
  return result;
}

test("default state uses the canonical path without creating directories", async t => {
  const p = await fixture(t);
  assert.equal(taskChefStateDir(p.home), p.current);
  assert.deepEqual(await readdir(p.home), []);
  await file(join(p.current, "tasks.jsonl"));
  assert.throws(() => taskChefStateDir(p.home), /storage needs migration/);
});

test("migration preserves native files and modes, archives dispatcher and registry, and repeats safely", async t => {
  const p = await fixture(t);
  await file(join(p.current, "tasks.jsonl"));
  await file(join(p.current, "backups", "snapshot.json"));
  for (const name of ["settings.json", "done.json", "github-auth/session.json", "notifications.json", "notifications.json.errors.json", "cache/usage/counters.json", "delegation-memory.md"]) {
    await file(join(p.previous, name), name);
  }
  const registry = join(p.home, ".codex/taskchef");
  await file(join(registry, "workspaces.json"));
  await file(join(registry, "projects/old.json"));
  const native = await inventory(p.previous), legacy = await inventory(p.current), oldRegistry = await inventory(registry);
  assert.equal(taskChefStateDir(p.home), p.previous);
  const result = await migrateTaskChefState(p.home, offline);
  assert.equal(result.state, p.current);
  assert.equal(taskChefStateDir(p.home), p.current);
  assert.deepEqual(await inventory(p.current), native);
  const archive = await inventory(p.archive);
  for (const [path, value] of Object.entries(legacy)) assert.deepEqual(archive[path], value);
  assert.deepEqual(await inventory(join(p.archive, "codex-registry")), oldRegistry);
  assert.equal(await readlink(p.previous), "taskchef");
  await file(join(p.previous, "done.json"), "old runtime write");
  assert.equal(await readFile(join(p.current, "done.json"), "utf8"), "old runtime write");
  const after = await inventory(p.current);
  await migrateTaskChefState(p.home, offline);
  assert.deepEqual(await inventory(p.current), after);
});

test("each interrupted rename layout resumes without merging data", async t => {
  for (const step of ["dispatcher-archived", "registry-archived", "native-moved"]) {
    const home = join((await fixture(t)).home, step), p = taskChefStatePaths(home);
    await file(join(p.archive, "tasks.jsonl"));
    await file(join(step === "native-moved" ? p.current : p.previous, "settings.json"));
    await file(join(home, step === "dispatcher-archived" ? ".codex/taskchef/workspaces.json" : ".agents/taskchef-old/codex-registry/workspaces.json"));
    await migrateTaskChefState(home, offline);
    assert.equal(taskChefStateDir(home), p.current);
    assert.equal(await readlink(p.previous), "taskchef");
  }
});

test("collisions, unknown sources, links and leftover locks fail before moving data", async t => {
  for (const kind of ["archive", "both-native", "registry", "dispatcher-registry-empty", "dispatcher-registry-nonempty", "unknown-source", "dangling-link", "lock"]) {
    const p = await fixture(t);
    await file(join(p.current, kind === "both-native" ? "settings.json" : "tasks.jsonl"));
    if (kind === "dangling-link") await symlink("missing", p.previous);
    else await file(join(p.previous, kind === "unknown-source" ? "unknown" : "done.json"));
    if (kind === "archive") await mkdir(p.archive);
    if (kind === "registry") {
      await file(join(p.home, ".codex/taskchef/workspaces.json"));
      await file(join(p.archive, "codex-registry/workspaces.json"));
    }
    if (kind.startsWith("dispatcher-registry-")) {
      await file(join(p.registry, "workspaces.json"));
      await mkdir(join(p.current, "codex-registry"));
      if (kind.endsWith("nonempty")) await file(join(p.current, "codex-registry/historical.json"));
    }
    if (kind === "lock") await mkdir(p.lock);
    const before = await inventory(p.current);
    await assert.rejects(migrateTaskChefState(p.home, offline));
    assert.deepEqual(await inventory(p.current), before);
    assert.equal(await readFile(join(p.current, kind === "both-native" ? "settings.json" : "tasks.jsonl"), "utf8"), "preserve me");
    if (["archive", "registry"].includes(kind) || kind.startsWith("dispatcher-registry-")) assert.equal(taskChefStateDir(p.home), p.previous);
    else assert.throws(() => taskChefStateDir(p.home), /migration/);
  }
});

test("writer refusal leaves both stores intact and releases its migration lock", async t => {
  const p = await fixture(t);
  await file(join(p.current, "tasks.jsonl"));
  await file(join(p.previous, "settings.json"));
  await assert.rejects(migrateTaskChefState(p.home, { assertStopped: async () => { throw new Error("writer active"); } }), /writer active/);
  assert.equal(await readFile(join(p.current, "tasks.jsonl"), "utf8"), "preserve me");
  assert.equal(await readFile(join(p.previous, "settings.json"), "utf8"), "preserve me");
  await assert.rejects(lstat(p.lock), { code: "ENOENT" });
});

test("writer inspection catches relative MCP commands and legacy cwd but permits tests", async t => {
  const p = await fixture(t), plugin = join(p.home, "plugin");
  await file(join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name: "taskchef-dev" }));
  const runCommand = command => Promise.resolve({ stdout: command === "lsof" ? `p90001\nn${plugin}\n` : "90001 node ./mcp/server.js\n" });
  for (const name of ["taskchef", "taskchef-dev", "taskchef-next"]) {
    await file(join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name }));
    await assert.rejects(assertNoStateWriters(p, runCommand), /90001/);
  }
  await assertNoStateWriters(p, command => Promise.resolve({ stdout: command === "lsof" ? `p90001\nn${plugin}\n` : "90001 node --test tests/taskchef-state.test.js\n" }));
  await assert.rejects(assertNoStateWriters(p, command => Promise.resolve({ stdout: command === "lsof" ? `p90003\nn/private/tmp\n` : `90003 node ${plugin}/mcp/server.js\n` })), /90003/);
  const spaced = join(p.home, "plugin with spaces");
  await file(join(spaced, ".codex-plugin/plugin.json"), JSON.stringify({ name: "taskchef" }));
  await assert.rejects(assertNoStateWriters(p, command => Promise.resolve({ stdout: command === "lsof" ? `p90004\nn/private/tmp\n` : `90004 /usr/bin/node ${spaced}/mcp/server.js\n` })), /90004/);
  await assert.rejects(assertNoStateWriters(p, async () => ({ stdout: `p90002\nn${p.current}\n` })), /90002/);
  await assert.rejects(assertNoStateWriters(p, async () => ({ stdout: `p90005\nn${p.registry}/projects\n` })), /90005/);
  await assert.rejects(assertNoStateWriters(p, async () => { throw new Error("permission denied"); }), /Cannot establish/);
});

test("memory-only and historical cache-only native stores migrate intact", async t => {
  for (const name of ["delegation-memory.md", "usage-cache/result.json", "pricing.json", "notifications.json.errors.json"]) {
    const p = await fixture(t);
    await file(join(p.previous, name));
    assert.equal(taskChefStateDir(p.home), p.previous);
    const before = await inventory(p.previous);
    await migrateTaskChefState(p.home, offline);
    assert.equal(taskChefStateDir(p.home), p.current);
    assert.deepEqual(await inventory(p.current), before);
  }
});
