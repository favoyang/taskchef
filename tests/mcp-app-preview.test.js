import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareMcpAppPreview } from "../scripts/prepare-mcp-app-preview.js";
import { TASKCHEF_APP_NAME } from "../src/version.js";
import { updateMcpAppPreview } from "../scripts/update-mcp-app-preview.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "taskchef-ui-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".codex-plugin"));
  await mkdir(join(root, "src/mcp-app/dist"), { recursive: true });
  const manifest = JSON.stringify({ name: "taskchef-dev", version: "1-dev.1" });
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
  assert.equal(result.version, "1-dev.1");
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
  await assert.rejects(updateMcpAppPreview(root, source), /TaskChef preview/);
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


test("development identity stays in the staging copy and leaves the release unchanged", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, ".codex-plugin/plugin.json"), JSON.stringify({ name: "taskchef", version: "8.7.0", interface: { displayName: "TaskChef" } }));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { taskchef: { command: "node", args: ["./mcp/server.js"] } } }));
  await assert.rejects(prepareMcpAppPreview(root), /development identity/);
  assert.equal(JSON.parse(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8")).name, "taskchef");
  await writeFile(join(root, ".codex-plugin/plugin.json"), JSON.stringify({ name: "taskchef-dev", version: "8.7.0", interface: { displayName: "TaskChef", defaultPrompt: ["$taskchef:delegate Do X"] } }));
  const result = await prepareMcpAppPreview(root);
  assert.deepEqual(result, { name: "taskchef-dev", displayName: "TaskChef Dev", version: "8.7.0" });
  const prepared = JSON.parse(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8"));
  assert.deepEqual(prepared.interface.defaultPrompt, ["$taskchef-dev:delegate Do X"]);
  const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers, { "taskchef-dev": { command: "node", args: ["./mcp/server.js"] } });
  assert.deepEqual(await prepareMcpAppPreview(root), result);
  // An existing Dev staging copy can retain the old server and prompt keys.
  prepared.interface.defaultPrompt = ["$taskchef-next:delegate Do X"];
  await writeFile(join(root, ".codex-plugin/plugin.json"), JSON.stringify(prepared));
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { "taskchef-next": mcp.mcpServers["taskchef-dev"] } }));
  assert.deepEqual(await prepareMcpAppPreview(root), result);
  assert.deepEqual(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")).mcpServers, mcp.mcpServers);
  assert.deepEqual(JSON.parse(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8")).interface.defaultPrompt, ["$taskchef-dev:delegate Do X"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", version: "8.7.0" }));
  await writeFile(join(root, "src/version.js"), await readFile(new URL("../src/version.js", import.meta.url)));
  assert.equal((await import(pathToFileURL(join(root, "src/version.js")).href)).TASKCHEF_APP_NAME, "TaskChef Dev");
  assert.equal(TASKCHEF_APP_NAME, "TaskChef");
  await assert.rejects(prepareMcpAppPreview(new URL("../", import.meta.url).pathname), /release checkout/);
  await writeFile(join(root, ".codex-plugin/plugin.json"), JSON.stringify({ name: "other" }));
  await assert.rejects(prepareMcpAppPreview(root), /development identity/);
});
