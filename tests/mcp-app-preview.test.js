import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateMcpAppPreview } from "../scripts/update-mcp-app-preview.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "taskchef-ui-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".codex-plugin"));
  await mkdir(join(root, "src/mcp-app/dist"), { recursive: true });
  const manifest = JSON.stringify({ name: "taskchef-next", version: "1-next.1" });
  await writeFile(join(root, ".codex-plugin/plugin.json"), manifest);
  const target = join(root, "src/mcp-app/dist/index.html");
  await writeFile(target, "<!doctype html><p>Old UI</p>");
  const source = join(root, "new.html");
  await writeFile(source, "<!doctype html><p>New UI</p>");
  return { root, target, source, manifest };
}

test("UI update changes only the existing HTML and keeps the plugin version", async (t) => {
  const { root, target, source, manifest } = await fixture(t);
  await writeFile(join(root, "server.js"), "unchanged server");
  const result = await updateMcpAppPreview(root, source);
  assert.equal(result.changed, true);
  assert.equal(result.version, "1-next.1");
  assert.equal(await readFile(target, "utf8"), await readFile(source, "utf8"));
  assert.equal(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8"), manifest);
  assert.equal(await readFile(join(root, "server.js"), "utf8"), "unchanged server");
  assert.deepEqual(await readdir(join(root, "src/mcp-app/dist")), ["index.html"]);
  assert.equal((await updateMcpAppPreview(root, source)).changed, false);
});

test("wrong plugin, invalid build and missing running HTML fail without replacing it", async (t) => {
  const { root, target, source, manifest } = await fixture(t);
  const original = await readFile(target, "utf8");
  await writeFile(join(root, ".codex-plugin/plugin.json"), '{"name":"another-plugin"}');
  await assert.rejects(updateMcpAppPreview(root, source), /TaskChef Next preview/);
  await writeFile(join(root, ".codex-plugin/plugin.json"), manifest);
  await writeFile(source, "not a built UI");
  await assert.rejects(updateMcpAppPreview(root, source), /Build the MCP app/);
  assert.equal(await readFile(target, "utf8"), original);
  await unlink(target);
  await assert.rejects(updateMcpAppPreview(root, source), /preview HTML is missing/);
});

test("redirected preview files cannot overwrite another file", async (t) => {
  const { root, target, source } = await fixture(t);
  const outside = join(root, "outside.html");
  await writeFile(outside, "preserved");
  await unlink(target);
  await symlink(outside, target);
  await assert.rejects(updateMcpAppPreview(root, source), /regular file inside/);
  assert.equal(await readFile(outside, "utf8"), "preserved");
});
