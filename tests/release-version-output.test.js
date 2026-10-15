import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
const execFile = promisify(execFileCallback);
const script = new URL("../scripts/write-release-version-output.js", import.meta.url).pathname;
test("manual release retry can repair catalog after main advances, but never treats an untagged version as published", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-release-output-"));
  try {
    const git = (...args) => execFile("git", args, { cwd: root });
    await git("init", "-q"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.com");
    await mkdir(path.join(root, ".codex-plugin"));
    const manifest = path.join(root, ".codex-plugin/plugin.json");
    await writeFile(manifest, JSON.stringify({ version: "9.3.0" }));
    await git("add", ".codex-plugin/plugin.json"); await git("commit", "-qm", "release"); await git("tag", "v9.3.0");
    const output = path.join(root, "output");
    const run = async retry => { await writeFile(output, ""); await execFile(process.execPath, [script], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: output, RETRY_PUBLISHED_VERSION: String(retry) } }); return readFile(output, "utf8"); };
    assert.equal(await run(false), "version=9.3.0\n");
    await git("commit", "--allow-empty", "-qm", "catalog");
    assert.equal(await run(false), "version=\n");
    assert.equal(await run(true), "version=9.3.0\n");
    await writeFile(manifest, JSON.stringify({ version: "9.4.0" }));
    assert.equal(await run(true), "version=\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
