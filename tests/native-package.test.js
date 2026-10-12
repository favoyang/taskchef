import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validatePublishedPluginPackage, validateExtractedPlugin, validateSkillFrontmatter } from "../scripts/update-shared-marketplace.js";
import { TASKCHEF_VERSION } from "../src/version.js";

test("release validation accepts the native plugin without the retired CLI", async () => {
  const manifest = await validateExtractedPlugin(new URL("../", import.meta.url).pathname, TASKCHEF_VERSION);
  assert.equal(manifest.interface.displayName, "TaskChef");
  const skill = await readFile(new URL("../skills/delegate/SKILL.md", import.meta.url), "utf8");
  assert.equal(validateSkillFrontmatter(skill, "delegate").name, "delegate");
});

test("archive validation requires the native UI, pricing, skill and runtime", () => {
  const paths = [".codex-plugin/plugin.json", ".mcp.json", "assets/taskchef.svg", "assets/taskchef-dark.svg", "assets/taskchef-sidebar.svg", "mcp/server.js", "node_modules/@modelcontextprotocol/sdk/package.json", "node_modules/proper-lockfile/package.json", "node_modules/zod/package.json", "src/mcp.js", "src/mcp-app.js", "src/file-lock.js", "src/codex-session-scanner.js", "src/mcp-app/dist/index.html", "src/data/codex-pricing.json", "skills/delegate/SKILL.md", "skills/delegate/agents/openai.yaml"];
  const packed = { id: `taskchef@${TASKCHEF_VERSION}`, files: paths.map(path => ({ path })) };
  assert.equal(validatePublishedPluginPackage([packed], TASKCHEF_VERSION), packed);
  for (const retired of ["mcp/dashboard-session.js", "bin/taskchef.js", "src/workspace.js", "assets/taskchef-dispatcher-instructions.md"]) {
    assert.throws(() => validatePublishedPluginPackage([{ ...packed, files: [...packed.files, { path: retired }] }], TASKCHEF_VERSION), /retired entrypoint/);
  }
  for (const missing of ["src/mcp-app/dist/index.html", "src/data/codex-pricing.json", "skills/delegate/SKILL.md", "src/file-lock.js"]) {
    assert.throws(() => validatePublishedPluginPackage([{ ...packed, files: packed.files.filter(file => file.path !== missing) }], TASKCHEF_VERSION), /missing/);
  }
});
