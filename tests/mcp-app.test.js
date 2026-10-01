import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTaskChefApp, TASKCHEF_APP_URI } from "../src/mcp-app.js";

const task = {
  id: "task-1", title: "Check board", status: "working", threadId: "0199aabb-ccdd-7eef-8abc-0123456789ab",
  turnRef: null, updatedAt: new Date().toISOString(), project: { name: "Example", path: "/example" },
};

test("MCP app advertises a UI resource and keeps board actions app-only", async () => {
  let refreshes = 0;
  let transitions = 0;
  let opened = null;
  const monitor = {
    tasks: [task],
    snapshot: () => ({ tasks: [task], healthy: true }),
    start: async () => {},
    refresh: async () => { refreshes += 1; },
    close: () => {},
  };
  const server = new McpServer({ name: "taskchef-app-test", version: "1" });
  registerTaskChefApp(server, {
    workspace: "/example",
    createMonitor: () => monitor,
    transition: async (_workspace, taskId, input) => {
      assert.equal(taskId, task.id);
      assert.equal(input.targetStatus, "completed");
      transitions += 1;
      return { task: { ...task, status: "completed" }, idempotent: false };
    },
    openThread: async (threadId) => { opened = threadId; },
  });
  const client = new Client({ name: "taskchef-app-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.find((item) => item.name === "open_taskchef_board")._meta.ui.resourceUri, TASKCHEF_APP_URI);
    assert.deepEqual(tools.find((item) => item.name === "open_taskchef_board")._meta["openai/ui"].entrypoints, [{ type: "global" }]);
    for (const tool of tools.filter((item) => item.name.startsWith("taskchef_app_"))) {
      assert.deepEqual(tool._meta.ui.visibility, ["app"]);
    }
    const resource = await client.readResource({ uri: TASKCHEF_APP_URI });
    assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(resource.contents[0].text, /TaskChef/);
    const initial = await client.callTool({ name: "open_taskchef_board", arguments: {} });
    assert.equal(initial.structuredContent.taskCount, 1);
    const snapshot = await client.callTool({ name: "taskchef_app_snapshot", arguments: {} });
    assert.equal(snapshot.structuredContent.snapshot.tasks[0].id, task.id);
    const detail = await client.callTool({ name: "taskchef_app_task", arguments: { taskId: task.id } });
    assert.equal(detail.structuredContent.task.title, task.title);
    const openedResult = await client.callTool({ name: "taskchef_app_open_chat", arguments: { taskId: task.id } });
    assert.equal(openedResult.isError, undefined);
    assert.equal(opened, task.threadId);
    const changed = await client.callTool({ name: "taskchef_app_transition", arguments: {
      taskId: task.id, actionId: randomUUID(), targetStatus: "completed",
      expected: { status: task.status, turnRef: task.turnRef, threadId: task.threadId, updatedAt: task.updatedAt },
    } });
    assert.equal(changed.structuredContent.task.status, "completed");
    assert.equal(transitions, 1);
    assert.ok(refreshes > 0);
  } finally {
    await client.close();
    await server.close();
  }
});
