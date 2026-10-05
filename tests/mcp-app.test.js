import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTaskChefApp, TASKCHEF_APP_URI } from "../src/mcp-app.js";

const task = { id: "0199aabb-ccdd-7eef-8abc-0123456789ab", title: "Codex chat", status: null, threadId: "0199aabb-ccdd-7eef-8abc-0123456789ab" };

test("TaskChef Next sidebar exposes only read-only scan and chat navigation tools", async () => {
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
    close: () => {},
  };
  const server = new McpServer({ name: "taskchef-next-test", version: "1" });
  registerTaskChefApp(server, { createScanner: () => scanner, openThread: async (id) => { opened = id; } });
  const client = new Client({ name: "taskchef-next-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.find((item) => item.name === "open_taskchef_board").title, "TaskChef Next");
    assert.equal(tools.find((item) => item.name === "open_taskchef_board")._meta.ui.resourceUri, TASKCHEF_APP_URI);
    assert.equal(tools.find((item) => item.name === "taskchef_app_transition"), undefined);
    for (const tool of tools.filter((item) => item.name.startsWith("taskchef_app_"))) assert.deepEqual(tool._meta.ui.visibility, ["app"]);
    const resource = await client.readResource({ uri: TASKCHEF_APP_URI });
    assert.match(resource.contents[0].text, /TaskChef Next/);
    const initial = await client.callTool({ name: "open_taskchef_board", arguments: {} });
    assert.equal(initial.structuredContent.taskCount, 1);
    const snapshot = await client.callTool({ name: "taskchef_app_snapshot", arguments: {} });
    assert.equal(snapshot.structuredContent.snapshot.scan.indexedFiles, 1);
    const unchanged = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision } });
    assert.deepEqual(unchanged.structuredContent, { unchanged: true, revision, scan: { mode: "full", indexedFiles: 1 } });
    const forced = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision, force: true } });
    assert.equal(forced.structuredContent.snapshot.revision, 2);
    const detail = await client.callTool({ name: "taskchef_app_task", arguments: { taskId: task.id } });
    assert.equal(detail.structuredContent.task.title, task.title);
    await client.callTool({ name: "taskchef_app_open_chat", arguments: { taskId: task.id } });
    assert.equal(opened, task.id);
    assert.ok(scans >= 4);
  } finally { await client.close(); await server.close(); }
});
