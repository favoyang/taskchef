import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveExpectedPublishedPlugin, validatePublishedPluginPackage, validateExtractedPlugin, validateSkillFrontmatter } from "../scripts/update-plugin-marketplace.js";
import { TASKCHEF_VERSION } from "../src/version.js";

test("release readiness waits for npm processing beyond the first minute", async () => {
  let elapsedMs = 0;
  const verified = [];
  const version = await resolveExpectedPublishedPlugin(TASKCHEF_VERSION, {
    readVersionImpl: async () => elapsedMs < 180000 ? "0.0.0" : TASKCHEF_VERSION,
    verifyVersionImpl: async (value) => { verified.push(value); },
    waitImpl: async (duration) => { elapsedMs += duration; },
  });
  assert.equal(version, TASKCHEF_VERSION);
  assert.equal(elapsedMs, 180000);
  assert.deepEqual(verified, [TASKCHEF_VERSION]);
});

test("release readiness stops polling when npm remains stale", async () => {
  const waits = [];
  let reads = 0;
  await assert.rejects(resolveExpectedPublishedPlugin(TASKCHEF_VERSION, {
    readVersionImpl: async () => { reads += 1; return "0.0.0"; },
    verifyVersionImpl: async () => { assert.fail("stale latest must not be verified"); },
    waitImpl: async (duration) => { waits.push(duration); },
  }), /after 60 attempts: npm latest is 0\.0\.0/);
  assert.equal(reads, 60);
  assert.equal(waits.length, 59);
  assert.equal(waits.reduce((total, duration) => total + duration, 0), 590000);
});

test("release readiness retries archive validation before accepting npm latest", async () => {
  let verifications = 0;
  const waits = [];
  assert.equal(await resolveExpectedPublishedPlugin(TASKCHEF_VERSION, {
    readVersionImpl: async () => TASKCHEF_VERSION,
    verifyVersionImpl: async () => {
      verifications += 1;
      if (verifications === 1) throw new Error("archive is still processing");
    },
    waitImpl: async (duration) => { waits.push(duration); },
  }), TASKCHEF_VERSION);
  assert.equal(verifications, 2);
  assert.deepEqual(waits, [10000]);
});

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
