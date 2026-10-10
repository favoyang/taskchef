import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextGitHub } from "../src/next-github.js";
import { registerTaskChefApp, pluginSettingsUrl, TASKCHEF_APP_URI, TASKCHEF_GITHUB_URI } from "../src/mcp-app.js";

const task = { turnId: "turn-one", observed: { archive: false, source: "vscode", lastTurnEvent: null }, id: "0199aabb-ccdd-7eef-8abc-0123456789ab", title: "Codex chat", status: null, threadId: "0199aabb-ccdd-7eef-8abc-0123456789ab" };

test("TaskChef sidebar exposes database reads, local Done marks, and chat navigation", async (t) => {
  assert.equal(TASKCHEF_APP_URI, "ui://taskchef/task-board/v3");
  let revision = 1;
  let scans = 0;
  let opened = null;
  let settingsOpened = null;
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
  let credential = {};
  const scopes = [];
  const forces = [];
  const github = new NextGitHub({ stateDir: temp, credentials: { read: async () => credential, write: async (_, value) => { credential = value; }, remove: async () => { credential = {}; } }, fetch: async () => { throw new Error("Unexpected GitHub request"); } });
  const enrich = github.enrich.bind(github);
  github.enrich = async (snapshot, settings, options) => { scopes.push(options?.scope); forces.push(options?.force); return enrich(snapshot, settings, options); };
  registerTaskChefApp(server, { createGitHub: () => github, settingsPath, createScanner: () => scanner, openThread: async (id) => { opened = id; }, getSettingsUrl: async () => "codex://plugins/taskchef-next?marketplacePath=%2Fexample", openSettings: async (url) => { settingsOpened = url; } });
  const client = new Client({ name: "taskchef-next-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const defaults = { showCalendarDates: false, showExec: false, showCli: false, showArchived: false };
    assert.deepEqual(client.getServerCapabilities().experimental["openai/settings"], { readTool: "taskchef_settings_read", updateTool: "taskchef_settings_update" });
    const settings = await client.callTool({ name: "taskchef_settings_read", arguments: {} });
    assert.deepEqual(settings.structuredContent.values, defaults);
    assert.equal(settings.structuredContent.schema.properties.showExec.type, "boolean");
    assert.deepEqual(settings.structuredContent.layout.flatMap((group) => group.items.filter((item) => item.kind === "property").map((item) => item.property)), ["showExec", "showCli", "showArchived", "showCalendarDates"]);
    const action = settings.structuredContent.layout.find(group => group.title === "GitHub").items.find(item => item.kind === "tool");
    assert.equal(action.title, "Connect GitHub");
    assert.equal(settings.structuredContent.schema.properties.githubClientId, undefined);
    credential = { token: "test-token", login: "tester" };
    const connectedSettings = await client.callTool({ name: "taskchef_settings_read", arguments: {} });
    assert.equal(connectedSettings.structuredContent.layout.find(group => group.title === "GitHub").items[0].title, "Manage GitHub");
    credential = {};
    assert.equal(action.tool, "taskchef_github_settings");
    const githubSettings = await client.callTool({ name: action.tool, arguments: {} });
    assert.equal(githubSettings.structuredContent.github.connected, false);
    const settingsResource = await client.readResource({ uri: TASKCHEF_GITHUB_URI });
    assert.match(settingsResource.contents[0].text, /data-taskchef-page="github"/);
    await assert.rejects(access(settingsPath));
    const updated = await client.callTool({ name: "taskchef_settings_update", arguments: { set: { showCli: true } } });
    assert.deepEqual(updated.structuredContent.values, { ...defaults, showCli: true });
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { ...updated.structuredContent.values, githubClientId: "Iv23likjK80RCtqZFGg8" });
    for (const set of [{}, { bogus: true }, { showExec: "yes" }, { showCalendarDates: "yes" }, { githubClientId: "Iv1.test" }]) {
      const invalid = await client.callTool({ name: "taskchef_settings_update", arguments: { set } });
      assert.equal(invalid.isError, true);
    }
    await client.callTool({ name: "taskchef_settings_update", arguments: { set: { showCalendarDates: true } } });
    assert.equal((await client.callTool({ name: "taskchef_settings_read", arguments: {} })).structuredContent.values.showCalendarDates, true);
    await client.callTool({ name: "taskchef_settings_update", arguments: { set: { showCalendarDates: false } } });
    await client.callTool({ name: "taskchef_settings_update", arguments: { set: { showCli: false } } });
    const { tools } = await client.listTools();
    assert.ok(tools.find((tool) => tool.name === "taskchef_settings_read").outputSchema);
    assert.equal(tools.find((item) => item.name === "open_taskchef_board").title, "TaskChef");
    assert.equal(tools.find((item) => item.name === "open_taskchef_board")._meta.ui.resourceUri, TASKCHEF_APP_URI);
    assert.equal(tools.find((item) => item.name === "taskchef_app_transition"), undefined);
    for (const tool of tools.filter((item) => item.name.startsWith("taskchef_app_"))) assert.deepEqual(tool._meta.ui.visibility, ["app"]);
    const resource = await client.readResource({ uri: TASKCHEF_APP_URI, TASKCHEF_GITHUB_URI });
    assert.match(resource.contents[0].text, /TaskChef/);
    assert.deepEqual(resource.contents[0]._meta.ui.csp.resourceDomains, ["https:"]);
    const image = await client.callTool({ name: "taskchef_app_image", arguments: { taskId: task.id, expectedTurnId: "turn-one", expectedUrl: "/image.png" } });
    assert.equal(image.structuredContent.dataUrl, "data:image/png;base64,AAAA");
    const initial = await client.callTool({ name: "open_taskchef_board", arguments: {} });
    assert.equal(initial.structuredContent.taskCount, 1);
    const snapshot = await client.callTool({ name: "taskchef_app_snapshot", arguments: {} });
    assert.equal(snapshot.structuredContent.snapshot.scan.indexedFiles, 1);
    assert.deepEqual(scopes.at(-1), { date: "all", project: undefined, taskIds: [] });
    await client.callTool({ name: "taskchef_app_snapshot", arguments: { visibleTaskIds: [task.id] } });
    assert.deepEqual(scopes.at(-1).taskIds, [task.id]);
    const unchanged = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision } });
    assert.deepEqual(unchanged.structuredContent, { unchanged: true, revision, scan: { mode: "full", indexedFiles: 1 }, settings: defaults, settingsUrl: "codex://plugins/taskchef-next?marketplacePath=%2Fexample", notifications: snapshot.structuredContent.notifications, github: { configured: true, connected: false, login: null } });
    await writeFile(settingsPath, JSON.stringify({ ...defaults, showExec: true }));
    const settingsOnly = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision } });
    assert.equal(settingsOnly.structuredContent.unchanged, true);
    assert.equal(settingsOnly.structuredContent.settings.showExec, true);
    const forced = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision, force: true } });
    assert.equal(forced.structuredContent.snapshot.revision, 2);
    assert.equal(forces.at(-1), true);
    const detail = await client.callTool({ name: "taskchef_app_task", arguments: { taskId: task.id } });
    assert.equal(forces.at(-1), false);
    await client.callTool({ name: "taskchef_app_task", arguments: { taskId: task.id, refreshGithub: true } });
    assert.deepEqual(forces.slice(-2), [true, false]);
    assert.equal(detail.structuredContent.task.title, task.title);
    await client.callTool({ name: "taskchef_app_open_settings", arguments: {} });
    assert.equal(settingsOpened, "codex://plugins/taskchef-next?marketplacePath=%2Fexample");
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
  const root = join(temp, "marketplace");
  const marketplacePath = join(root, ".agents", "plugins", "marketplace.json");
  await mkdir(dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, JSON.stringify({ name: "preview", plugins: [{ name: "taskchef-next" }] }));
  await writeFile(join(temp, "config.toml"), `[marketplaces.preview]\nsource = ${JSON.stringify(root)}\n`);
  const url = await pluginSettingsUrl({ codexHome: temp, pluginRoot: "/example/cache/preview/taskchef-next/1/" });
  assert.equal(url, `codex://plugins/taskchef-next?${new URLSearchParams({ marketplacePath })}`);
  assert.equal(await pluginSettingsUrl({ codexHome: temp, pluginRoot: "/unknown/" }), null);
  await writeFile(marketplacePath, JSON.stringify({ name: "preview", plugins: [] }));
  assert.equal(await pluginSettingsUrl({ codexHome: temp, pluginRoot: "/example/cache/preview/taskchef-next/1/" }), null);
});


test("plugin settings uses the native desktop opener and reports errors", async () => {
  const { openPluginSettingsInCodex } = await import("../src/codex-app.js");
  const url = "codex://plugins/taskchef-next?marketplacePath=%2Fexample";
  for (const [platform, command, args] of [
    ["darwin", "/usr/bin/open", [url]],
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", url]],
    ["linux", "xdg-open", [url]],
  ]) {
    let invocation;
    await openPluginSettingsInCodex(url, { platform, run: async (...values) => { invocation = values; } });
    assert.equal(invocation[0], command);
    assert.deepEqual(invocation[1], args);
  }
  await assert.rejects(openPluginSettingsInCodex(url, { run: async () => { throw new Error("Opener failed"); } }), /Opener failed/);
  for (const invalid of [null, "codex://plugins", "https://example.com", "codex://plugins/taskchef-next?marketplacePath=relative", "codex://plugins/taskchef-next?marketplacePath=%2Fexample&other=value"]) {
    await assert.rejects(openPluginSettingsInCodex(invalid, { run: async () => assert.fail("Must not open invalid URL") }));
  }
});

test("board usage is scoped to visible cards, revises with usage, and clears on a new turn", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "taskchef-card-usage-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const task = {id:"01a00000-0000-7000-8000-000000000001",title:"Usage",status:"needs_input",turnId:"one",project:{name:"Test",path:"/test"},pullRequests:[]};
  const requests=[];
  let tokens=100;
  const scanner={task:id=>id===task.id?task:null,refresh:async()=>({healthy:true,revision:1,tasks:[task],scan:{}}),taskUsage:async id=>{requests.push(id);return {latest:{tokens:{total_tokens:tokens},samples:1,costUsd:1}};},close(){}};
  const github={enrich:async snapshot=>({snapshot,auth:{connected:false}}),auth:async()=>({connected:false})};
  const server=new McpServer({name:"usage-test",version:"1"});
  registerTaskChefApp(server,{createScanner:()=>scanner,createGitHub:()=>github,settingsPath:join(temp,"settings.json"),getSettingsUrl:async()=>null});
  const client=new Client({name:"usage-client",version:"1"});
  const [ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct);
  t.after(async()=>{await client.close();await server.close();});
  const read=async args=>(await client.callTool({name:"taskchef_app_snapshot",arguments:args})).structuredContent;
  const initial=await read({});assert.equal(requests.length,0);
  await read({revision:initial.snapshot.revision,visibleTaskIds:[task.id]});
  await new Promise(resolve=>setImmediate(resolve));
  const populated=await read({revision:initial.snapshot.revision});
  assert.equal(populated.snapshot.tasks[0].turnUsage.tokens.total_tokens,100);
  assert.equal((await read({revision:populated.snapshot.revision})).unchanged,true);
  tokens=200;
  await read({revision:populated.snapshot.revision,visibleTaskIds:[task.id]});
  await new Promise(resolve=>setImmediate(resolve));
  const changed=await read({revision:populated.snapshot.revision});
  assert.equal(changed.snapshot.tasks[0].turnUsage.tokens.total_tokens,200);
  task.turnId="two";
  const newTurn=await read({revision:changed.snapshot.revision});
  assert.equal(newTurn.snapshot.tasks[0].turnUsage,undefined);
});
