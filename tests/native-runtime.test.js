import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTaskChefMcpServer } from "../src/mcp.js";
import { acquireFileLock } from "../src/file-lock.js";
import { isCodexThreadDeepLinkId, openThreadInCodex } from "../src/codex-app.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "taskchef-native-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("native MCP registers without a dispatcher and preserves legacy data", async (t) => {
  const root = await fixture(t);
  const legacy = join(root, "legacy");
  await mkdir(legacy);
  await writeFile(join(legacy, "tasks.jsonl"), "legacy content\n");
  await writeFile(join(legacy, "config.json"), "invalid old config");
  const before = await readdir(legacy);
  const server = createTaskChefMcpServer({
    workspace: legacy,
    createScanner: () => ({ close() {} }),
    createGitHub: () => ({}),
    settingsPath: join(root, "native", "settings.json"),
  });
  const client = new Client({ name: "native-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === "open_taskchef_board"));
    for (const name of ["ensure_dashboard", "prepare_dispatch", "record_task", "link_task", "report_state", "report_result", "reconcile_projects", "include_project", "update_project_hint"]) {
      assert.ok(!tools.some(tool => tool.name === name), name);
    }
    assert.deepEqual(await readdir(legacy), before);
    assert.equal(await readFile(join(legacy, "tasks.jsonl"), "utf8"), "legacy content\n");
  } finally { await client.close(); await server.close(); }
});

test("the shared lock serializes competing native state writes", async (t) => {
  const root = await fixture(t);
  const state = join(root, "counter");
  await writeFile(state, "0");
  await Promise.all(Array.from({ length: 4 }, async () => {
    const release = await acquireFileLock(root);
    try {
      const value = Number(await readFile(state, "utf8"));
      await new Promise(resolve => setTimeout(resolve, 15));
      await writeFile(state, String(value + 1));
    } finally { await release(); }
  }));
  assert.equal(await readFile(state, "utf8"), "4");
});

test("open-chat boundary accepts UUIDs without a v7 restriction and rejects malformed IDs before launch", async () => {
  assert.equal(isCodexThreadDeepLinkId("0199aabb-ccdd-7eef-8abc-0123456789ab"), true);
  assert.equal(isCodexThreadDeepLinkId("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isCodexThreadDeepLinkId("bad?url=other"), false);
  let ran = false;
  await assert.rejects(openThreadInCodex("bad", { run: () => { ran = true; } }));
  assert.equal(ran, false);
});
