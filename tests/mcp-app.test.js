import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTaskChefApp, pluginSettingsUrl, TASKCHEF_APP_URI } from "../src/mcp-app.js";

const task = { id: "0199aabb-ccdd-7eef-8abc-0123456789ab", title: "Codex chat", status: null, threadId: "0199aabb-ccdd-7eef-8abc-0123456789ab" };

test("TaskChef Next sidebar exposes database reads, local Done marks, and chat navigation", async (t) => {
  assert.equal(TASKCHEF_APP_URI, "ui://taskchef/task-board/v3");
  let revision = 1;
  let scans = 0;
  let opened = null;
  const scanner = {
    refresh: async ({ force } = {}) => {
      scans += 1;
      if (force) revision += 1;
      return { healthy: true, revision, tasks: [task], scan: { mode: force ? "incremental" : "full", indexedFiles: 1 } };
    },
    task: (id) => id === task.id ? task : null,
    taskImage: async (id, turn, url) => { assert.equal(id, task.id); assert.equal(turn, "turn-one"); assert.equal(url, "/image.png"); return "data:image/png;base64,AAAA"; },
    taskDetail: async (id) => id === task.id ? task : null,
    setDone: async (id, expectedTurnId, done) => { assert.equal(id, task.id); assert.equal(expectedTurnId, "turn-one"); return { ...task, manualDone: done }; },
    close: () => {},
  };
  const temp = await mkdtemp(join(tmpdir(), "taskchef-native-settings-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const settingsPath = join(temp, "settings.json");
  const server = new McpServer({ name: "taskchef-next-test", version: "1" });
  registerTaskChefApp(server, { settingsPath, createScanner: () => scanner, openThread: async (id) => { opened = id; } });
  const client = new Client({ name: "taskchef-next-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const defaults = { showExec: false, showCli: false, showArchived: false };
    assert.deepEqual(client.getServerCapabilities().experimental["openai/settings"], { readTool: "taskchef_settings_read", updateTool: "taskchef_settings_update" });
    const settings = await client.callTool({ name: "taskchef_settings_read", arguments: {} });
    assert.deepEqual(settings.structuredContent.values, defaults);
    assert.equal(settings.structuredContent.schema.properties.showExec.type, "boolean");
    assert.deepEqual(settings.structuredContent.layout[0].items.map((item) => item.property), Object.keys(defaults));
    await assert.rejects(access(settingsPath));
    const updated = await client.callTool({ name: "taskchef_settings_update", arguments: { set: { showCli: true } } });
    assert.deepEqual(updated.structuredContent.values, { ...defaults, showCli: true });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), updated.structuredContent.values);
    for (const set of [{}, { bogus: true }, { showExec: "yes" }]) {
      const invalid = await client.callTool({ name: "taskchef_settings_update", arguments: { set } });
      assert.equal(invalid.isError, true);
    }
    await client.callTool({ name: "taskchef_settings_update", arguments: { set: { showCli: false } } });
    const { tools } = await client.listTools();
    assert.ok(tools.find((tool) => tool.name === "taskchef_settings_read").outputSchema);
    assert.equal(tools.find((item) => item.name === "open_taskchef_board").title, "TaskChef Next");
    assert.equal(tools.find((item) => item.name === "open_taskchef_board")._meta.ui.resourceUri, TASKCHEF_APP_URI);
    assert.equal(tools.find((item) => item.name === "taskchef_app_transition"), undefined);
    for (const tool of tools.filter((item) => item.name.startsWith("taskchef_app_"))) assert.deepEqual(tool._meta.ui.visibility, ["app"]);
    const resource = await client.readResource({ uri: TASKCHEF_APP_URI });
    assert.match(resource.contents[0].text, /TaskChef Next/);
    assert.deepEqual(resource.contents[0]._meta.ui.csp.resourceDomains, ["https:"]);
    const image = await client.callTool({ name: "taskchef_app_image", arguments: { taskId: task.id, expectedTurnId: "turn-one", expectedUrl: "/image.png" } });
    assert.equal(image.structuredContent.dataUrl, "data:image/png;base64,AAAA");
    const initial = await client.callTool({ name: "open_taskchef_board", arguments: {} });
    assert.equal(initial.structuredContent.taskCount, 1);
    const snapshot = await client.callTool({ name: "taskchef_app_snapshot", arguments: {} });
    assert.equal(snapshot.structuredContent.snapshot.scan.indexedFiles, 1);
    const unchanged = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision } });
    assert.deepEqual(unchanged.structuredContent, { unchanged: true, revision, scan: { mode: "full", indexedFiles: 1 }, settings: defaults, settingsUrl: "codex://plugins", notifications: snapshot.structuredContent.notifications });
    await writeFile(settingsPath, JSON.stringify({ ...defaults, showExec: true }));
    const settingsOnly = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision } });
    assert.equal(settingsOnly.structuredContent.unchanged, true);
    assert.equal(settingsOnly.structuredContent.settings.showExec, true);
    const forced = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision, force: true } });
    assert.equal(forced.structuredContent.snapshot.revision, 2);
    const detail = await client.callTool({ name: "taskchef_app_task", arguments: { taskId: task.id } });
    assert.equal(detail.structuredContent.task.title, task.title);
    await client.callTool({ name: "taskchef_app_open_chat", arguments: { taskId: task.id } });
    assert.equal(opened, task.id);
    const done = await client.callTool({ name: "taskchef_app_set_done", arguments: { taskId: task.id, expectedTurnId: "turn-one", done: true } });
    assert.equal(done.structuredContent.task.manualDone, true);
    assert.equal(done.structuredContent.notifications.items[0].read, true);
    const cleared = await client.callTool({ name: "taskchef_app_notifications", arguments: { action: "clear" } });
    assert.equal(cleared.structuredContent.notifications.items.length, 0);
    assert.ok(scans >= 4);
  } finally { await client.close(); await server.close(); }
});


test("plugin settings link resolves the installed local marketplace", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "taskchef-plugin-link-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(join(temp, "config.toml"), '[marketplaces.preview]\nsource = "/example/marketplace"\n');
  const url = await pluginSettingsUrl({ codexHome: temp, pluginRoot: "/example/cache/preview/taskchef-next/1/" });
  assert.equal(url, "codex://plugins/taskchef-next?marketplacePath=%2Fexample%2Fmarketplace");
  assert.equal(await pluginSettingsUrl({ codexHome: temp, pluginRoot: "/unknown/" }), "codex://plugins");
});
