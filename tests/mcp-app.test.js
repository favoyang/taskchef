import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTaskChefApp, TASKCHEF_APP_URI } from "../src/mcp-app.js";

const task = {
  id: "task-1", title: "Check board", status: "working", threadId: "0199aabb-ccdd-7eef-8abc-0123456789ab",
  turnRef: null, updatedAt: new Date().toISOString(), project: { name: "Example", path: "/example", githubRepos: ["owner/repo"] },
  instruction: "Resolve owner/repo#12", summary: "owner/repo#12", turns: [], latestTurn: null,
};

test("MCP board title changes only for the preview environment", () => {
  const previous = process.env.TASKCHEF_PREVIEW;
  const titles = [];
  const server = {
    close: async () => {},
    registerResource: () => {},
    registerTool: (name, definition) => {
      if (name === "open_taskchef_board") titles.push(definition.title);
    },
  };
  try {
    delete process.env.TASKCHEF_PREVIEW;
    registerTaskChefApp(server);
    process.env.TASKCHEF_PREVIEW = "true";
    registerTaskChefApp(server);
    process.env.TASKCHEF_PREVIEW = "1";
    registerTaskChefApp(server);
    assert.deepEqual(titles, ["Open TaskChef task board", "Open TaskChef task board", "TaskChef Preview"]);
  } finally {
    if (previous === undefined) delete process.env.TASKCHEF_PREVIEW;
    else process.env.TASKCHEF_PREVIEW = previous;
  }
});

test("MCP app advertises a UI resource and keeps board actions app-only", async () => {
  let refreshes = 0;
  let transitions = 0;
  let opened = null;
  let usageReads = 0;
  let healthy = true;
  const monitor = Object.assign(new EventEmitter(), {
    tasks: [task],
    snapshot: () => ({ tasks: [task], healthy }),
    start: async () => {},
    refresh: async () => { refreshes += 1; },
    close: () => {},
  });
  Object.defineProperty(monitor, "unhealthy", { get: () => !healthy });
  const summary = Object.assign(new EventEmitter(), {
    start: async () => {}, close: () => {}, project: () => ({ status: "available", task: { totalTokens: 42 } }),
  });
  const server = new McpServer({ name: "taskchef-app-test", version: "1" });
  registerTaskChefApp(server, {
    workspace: "/example",
    createMonitor: () => monitor,
    createUsageSummaryMonitor: () => summary,
    createTaskUsageTracker: () => ({ get: async () => { usageReads += 1; return { status: "available", task: { totalTokens: 42 }, turns: {} }; }, preload: () => {}, close: () => {} }),
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
    assert.equal(snapshot.structuredContent.snapshot.tasks[0].usage.task.totalTokens, 42);
    const revision = snapshot.structuredContent.snapshot.revision;
    const unchanged = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision } });
    assert.deepEqual(unchanged.structuredContent, { unchanged: true, revision });
    summary.emit("change");
    const updatedUsage = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision } });
    assert.equal(updatedUsage.structuredContent.snapshot.revision, revision + 1);
    monitor.emit("snapshot");
    const changed = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision: revision + 1 } });
    assert.equal(changed.structuredContent.snapshot.revision, revision + 2);
    healthy = false;
    const unhealthy = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision: revision + 2 } });
    assert.equal(unhealthy.structuredContent.snapshot.healthy, false);
    healthy = true;
    monitor.emit("snapshot");
    const recovered = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision: revision + 2 } });
    assert.equal(recovered.structuredContent.snapshot.healthy, true);
    const detail = await client.callTool({ name: "taskchef_app_task", arguments: { taskId: task.id } });
    assert.equal(detail.structuredContent.task.title, task.title);
    assert.equal(detail.structuredContent.task.usage.task.totalTokens, 42);
    assert.equal(detail.structuredContent.task.relatedGitHubLinks[0].url, "https://github.com/owner/repo/issues/12");
    assert.equal(usageReads, 1);
    const openedResult = await client.callTool({ name: "taskchef_app_open_chat", arguments: { taskId: task.id } });
    assert.equal(openedResult.isError, undefined);
    assert.equal(opened, task.threadId);
    const transitionResult = await client.callTool({ name: "taskchef_app_transition", arguments: {
      taskId: task.id, actionId: randomUUID(), targetStatus: "completed",
      expected: { status: task.status, turnRef: task.turnRef, threadId: task.threadId, updatedAt: task.updatedAt },
    } });
    assert.equal(transitionResult.structuredContent.task.status, "completed");
    assert.equal(transitions, 1);
    assert.ok(refreshes > 0);
  } finally {
    await client.close();
    await server.close();
  }
});
