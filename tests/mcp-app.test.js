import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextGitHub } from "../src/next-github.js";
import { TASKCHEF_VERSION } from "../src/version.js";
import { registerTaskChefApp as registerApp, pluginSettingsUrl, TASKCHEF_APP_URI, TASKCHEF_GITHUB_URI } from "../src/mcp-app.js";

const registerTaskChefApp = (server, options) => registerApp(server, { createLiveState: () => ({ refresh: async () => {}, decorate: task => task, close: () => {} }), ...options });

const task = { turnId: "turn-one", observed: { archive: false, source: "vscode", lastTurnEvent: null }, id: "0199aabb-ccdd-7eef-8abc-0123456789ab", title: "Codex chat", status: null, threadId: "0199aabb-ccdd-7eef-8abc-0123456789ab" };

test("TaskChef sidebar exposes database reads, local Done marks, and chat navigation", async (t) => {
  assert.equal(TASKCHEF_APP_URI, `ui://taskchef/task-board/v3/${TASKCHEF_VERSION}`);
  assert.equal(TASKCHEF_GITHUB_URI, `ui://taskchef/github-settings/v1/${TASKCHEF_VERSION}`);
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
    calendarHistory: async (args) => ({ month: args.month, timeZone: args.timeZone, chats: args.settings.showCli ? [{ id: task.id, incomplete: false, segments: [] }] : [] }),
    task: (id) => id === task.id ? task : null,
    taskImage: async (id, turn, url) => { assert.equal(id, task.id); assert.equal(turn, "turn-one"); assert.equal(url, "/image.png"); return "data:image/png;base64,AAAA"; },
    taskDetail: async (id) => id === task.id ? task : null,
    setDone: async (id, expectedTurnId, done) => { assert.equal(id, task.id); assert.equal(expectedTurnId, "turn-one"); return { ...task, manualDone: done }; },
    close: () => {},
  };
  const temp = await mkdtemp(join(tmpdir(), "taskchef-native-settings-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const settingsPath = join(temp, "settings.json");
  const server = new McpServer({ name: "taskchef-dev-test", version: "1" });
  let credential = {};
  const scopes = [];
  const forces = [];
  const github = new NextGitHub({ stateDir: temp, credentials: { read: async () => credential, write: async (_, value) => { credential = value; }, remove: async () => { credential = {}; } }, fetch: async () => { throw new Error("Unexpected GitHub request"); } });
  const enrich = github.enrich.bind(github);
  github.enrich = async (snapshot, settings, options) => { scopes.push(options?.scope); forces.push(options?.force); return enrich(snapshot, settings, options); };
  registerTaskChefApp(server, { createGitHub: () => github, settingsPath, createScanner: () => scanner, openThread: async (id) => { opened = id; }, getSettingsUrl: async () => "codex://plugins/taskchef-dev?marketplacePath=%2Fexample", openSettings: async (url) => { settingsOpened = url; } });
  const client = new Client({ name: "taskchef-dev-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const defaults = { showCardUsage: true, showCalendarDates: false, showExec: false, showCli: false, showArchived: false };
    assert.deepEqual(client.getServerCapabilities().experimental["openai/settings"], { readTool: "taskchef_settings_read", updateTool: "taskchef_settings_update" });
    const settings = await client.callTool({ name: "taskchef_settings_read", arguments: {} });
    assert.deepEqual(settings.structuredContent.values, defaults);
    assert.equal(settings.structuredContent.schema.properties.showExec.type, "boolean");
    assert.deepEqual(settings.structuredContent.layout.flatMap((group) => group.items.filter((item) => item.kind === "property").map((item) => item.property)), ["showExec", "showCli", "showArchived", "showCalendarDates", "showCardUsage"]);
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
    for (const set of [{}, { bogus: true }, { showExec: "yes" }, { showCalendarDates: "yes" }, { showCardUsage: "yes" }, { githubClientId: "Iv1.test" }]) {
      const invalid = await client.callTool({ name: "taskchef_settings_update", arguments: { set } });
      assert.equal(invalid.isError, true);
    }
    await client.callTool({ name: "taskchef_settings_update", arguments: { set: { showCalendarDates: true } } });
    assert.equal((await client.callTool({ name: "taskchef_settings_read", arguments: {} })).structuredContent.values.showCalendarDates, true);
    await client.callTool({ name: "taskchef_settings_update", arguments: { set: { showCalendarDates: false } } });
    await client.callTool({ name: "taskchef_settings_update", arguments: { set: { showCardUsage: false } } });
    assert.equal((await client.callTool({ name: "taskchef_settings_read", arguments: {} })).structuredContent.values.showCardUsage, false);
    assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).showCardUsage, false);
    await client.callTool({ name: "taskchef_settings_update", arguments: { set: { showCardUsage: true } } });
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
    const calendar = await client.callTool({ name: "taskchef_app_calendar", arguments: { month: "2026-10", timeZone: "Asia/Singapore" } });
    assert.deepEqual(calendar.structuredContent, { month: "2026-10", timeZone: "Asia/Singapore", chats: [] });
    for (const args of [{ month: "2026-13", timeZone: "UTC" }, { month: "2026-10", timeZone: "Invalid/Timezone" }]) {
      assert.equal((await client.callTool({ name: "taskchef_app_calendar", arguments: args })).isError, true);
    }
    const initial = await client.callTool({ name: "open_taskchef_board", arguments: {} });
    assert.equal(initial.structuredContent.taskCount, 1);
    const snapshot = await client.callTool({ name: "taskchef_app_snapshot", arguments: {} });
    assert.equal(snapshot.structuredContent.snapshot.scan.indexedFiles, 1);
    assert.equal(snapshot.structuredContent.version, TASKCHEF_VERSION);
    assert.deepEqual(scopes.at(-1), { date: "all", project: undefined, taskIds: [] });
    await client.callTool({ name: "taskchef_app_snapshot", arguments: { visibleTaskIds: [task.id] } });
    assert.deepEqual(scopes.at(-1).taskIds, [task.id]);
    const unchanged = await client.callTool({ name: "taskchef_app_snapshot", arguments: { revision } });
    assert.deepEqual(unchanged.structuredContent, { unchanged: true, revision, scan: { mode: "full", indexedFiles: 1 }, settings: defaults, settingsUrl: "codex://plugins/taskchef-dev?marketplacePath=%2Fexample", notifications: snapshot.structuredContent.notifications, github: { configured: true, connected: false, login: null }, version: TASKCHEF_VERSION });
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
    assert.equal(settingsOpened, "codex://plugins/taskchef-dev?marketplacePath=%2Fexample");
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
  await writeFile(marketplacePath, JSON.stringify({ name: "preview", plugins: [{ name: "taskchef-dev" }] }));
  await writeFile(join(temp, "config.toml"), `[marketplaces.preview]\nsource = ${JSON.stringify(root)}\n`);
  const url = await pluginSettingsUrl({ codexHome: temp, pluginRoot: "/example/cache/preview/taskchef-dev/1/" });
  assert.equal(url, `codex://plugins/taskchef-dev?${new URLSearchParams({ marketplacePath })}`);
  assert.equal(await pluginSettingsUrl({ codexHome: temp, pluginRoot: "/unknown/" }), null);
  await writeFile(marketplacePath, JSON.stringify({ name: "preview", plugins: [] }));
  assert.equal(await pluginSettingsUrl({ codexHome: temp, pluginRoot: "/example/cache/preview/taskchef-dev/1/" }), null);
});


test("plugin settings resolves the Git marketplace snapshot used by a public installation", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "taskchef-git-plugin-link-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const marketplacePath = join(temp, ".tmp", "marketplaces", "taskchef", ".agents", "plugins", "marketplace.json");
  await mkdir(dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, JSON.stringify({ name: "taskchef", plugins: [{ name: "taskchef" }] }));
  await writeFile(join(temp, "config.toml"), '[marketplaces.taskchef]\nsource_type = "git"\nsource = "https://github.com/favoyang/taskchef.git"\n');
  const pluginRoot = join(temp, "plugins", "cache", "taskchef", "taskchef", "9.2.0") + "/";
  assert.equal(await pluginSettingsUrl({ codexHome: temp, pluginRoot }), `codex://plugins/taskchef?${new URLSearchParams({ marketplacePath })}`);
  await writeFile(marketplacePath, JSON.stringify({ name: "other", plugins: [{ name: "taskchef" }] }));
  assert.equal(await pluginSettingsUrl({ codexHome: temp, pluginRoot }), null);
});


test("plugin settings uses the native desktop opener and reports errors", async () => {
  const { openPluginSettingsInCodex } = await import("../src/codex-app.js");
  const url = "codex://plugins/taskchef-dev?marketplacePath=%2Fexample";
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
  for (const invalid of [null, "codex://plugins", "https://example.com", "codex://plugins/taskchef-dev?marketplacePath=relative", "codex://plugins/taskchef-dev?marketplacePath=%2Fexample&other=value"]) {
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

test("board looks up earlier PRs only for visible cards and tracks display-only changes", async t => {
  const temp=await mkdtemp(join(tmpdir(),"taskchef-earlier-pr-"));t.after(()=>rm(temp,{recursive:true,force:true}));
  const task={id:"01a00000-0000-7000-8000-000000000001",title:"Follow-up",status:"needs_input",turnId:"latest",project:{name:"Test",path:"/test"},pullRequests:[]};
  let earlier={url:"https://github.com/example/repo/pull/1",state:"unknown",checks:"unknown"};
  const reads=[];
  const scanner={task:id=>id===task.id?task:null,refresh:async()=>({healthy:true,revision:1,tasks:[task],scan:{}}),earlierPullRequest:id=>{reads.push(id);return earlier;},close(){}};
  const github={enrich:async snapshot=>({snapshot,auth:{connected:false}}),auth:async()=>({connected:false})};
  const server=new McpServer({name:"earlier-test",version:"1"});
  registerTaskChefApp(server,{createScanner:()=>scanner,createGitHub:()=>github,settingsPath:join(temp,"settings.json"),getSettingsUrl:async()=>null});
  const client=new Client({name:"earlier-client",version:"1"});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  t.after(async()=>{await client.close();await server.close();});
  const read=async args=>(await client.callTool({name:"taskchef_app_snapshot",arguments:args})).structuredContent;
  await read({});assert.deepEqual(reads,[]);
  const first=await read({visibleTaskIds:[task.id]});
  assert.equal(first.snapshot.tasks[0].earlierPullRequest.url,earlier.url);
  assert.deepEqual(first.snapshot.tasks[0].pullRequests,[]);
  assert.equal(first.snapshot.tasks[0].status,"needs_input");
  assert.equal((await read({visibleTaskIds:[task.id],revision:first.snapshot.revision})).unchanged,true);
  earlier={...earlier,url:"https://github.com/example/repo/pull/2"};
  const changed=await read({visibleTaskIds:[task.id],revision:first.snapshot.revision});
  assert.equal(changed.snapshot.tasks[0].earlierPullRequest.url,earlier.url);
  task.pullRequests=[earlier];
  const count=reads.length;
  assert.equal((await read({visibleTaskIds:[task.id]})).snapshot.tasks[0].earlierPullRequest,undefined);
  assert.equal(reads.length,count);
});

test("live approvals revise board and details; bridge errors notify once without hiding tasks", async t => {
 const temp=await mkdtemp(join(tmpdir(),"taskchef-live-app-"));t.after(()=>rm(temp,{recursive:true,force:true}));
 let pending=true;
 const running={...task,status:'working',observed:{...task.observed,lastTurnEvent:'inProgress'}};
 const live={refresh:async()=>{},decorate:value=>value&&pending?{...value,needsApproval:true,status:'needs_input',pendingApprovals:[{id:'16',turnId:value.turnId,title:'Browser use',message:'Allow upload?',origin:'https://mail.google.com'}]}:value,close:()=>{},error:null};
 const scanner={refresh:async()=>({healthy:true,revision:1,tasks:[running],scan:{}}),taskDetail:async()=>running,close:()=>{}};
 const server=new McpServer({name:'live-test',version:'1'});
 registerTaskChefApp(server,{settingsPath:join(temp,'settings.json'),createScanner:()=>scanner,createLiveState:()=>live,getSettingsUrl:async()=>null,createGitHub:()=>({enrich:async snapshot=>({snapshot,auth:{connected:false}})})});
 const client=new Client({name:'live-client',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 t.after(async()=>{await client.close();await server.close();});
 const first=(await client.callTool({name:'taskchef_app_snapshot',arguments:{}})).structuredContent;
 assert.equal(first.snapshot.tasks[0].needsApproval,true);
 assert.equal(first.notifications.items.length,0);
 const detail=(await client.callTool({name:'taskchef_app_task',arguments:{taskId:task.id}})).structuredContent;
 assert.deepEqual(detail.task.pendingApprovals,first.snapshot.tasks[0].pendingApprovals);
 await mkdir(join(temp,'notifications.json.errors.json'));
 pending=false;live.error='Codex IPC connection closed';
 const second=(await client.callTool({name:'taskchef_app_snapshot',arguments:{revision:first.snapshot.revision}})).structuredContent;
 assert.equal(second.snapshot.tasks[0].status,'working');assert.ok(second.snapshot.revision>first.snapshot.revision);
 assert.equal(second.notifications.items.length,1);
 const third=(await client.callTool({name:'taskchef_app_snapshot',arguments:{revision:second.snapshot.revision}})).structuredContent;
 assert.equal(third.unchanged,true);assert.equal(third.notifications.items.length,1);
});

async function until(check) {
 for(let attempt=0;attempt<200;attempt++) {
  if(await check()) return;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.fail('Timed out waiting for usage refresh');
}
async function settled(call) {
 let result;
 await until(async()=>{result=(await call()).structuredContent;return !result.loading && !result.refreshing;});
 return result;
}

test('usage history is app-only, validates range/timezone, and does not pass Board visibility', async t => {
 const temp=await mkdtemp(join(tmpdir(),'taskchef-analytics-tool-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const server=new McpServer({name:'usage-test',version:'1'});const calls=[];
 registerTaskChefApp(server,{settingsPath:join(temp,'settings.json'),createScanner:()=>({close(){},usageHistory:async args=>{calls.push(args);return[];}}),getSettingsUrl:async()=>null});
 const client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 let result=await client.callTool({name:'taskchef_app_usage',arguments:{range:'mtd',timeZone:'Asia/Singapore'}});
 if (result.structuredContent.loading) result=await client.callTool({name:'taskchef_app_usage',arguments:{range:'mtd',timeZone:'Asia/Singapore'}});
 assert.equal(result.structuredContent.samples,0);assert.equal(calls[0].settings,undefined);
 assert.equal((await client.callTool({name:'taskchef_app_usage',arguments:{range:'custom',timeZone:'UTC'}})).isError,true);
 assert.equal((await client.callTool({name:'taskchef_app_usage',arguments:{range:'7d',timeZone:'invalid/timezone'}})).isError,true);
 assert.equal(calls.length,1);
});

test('usage polling returns immediately, shares pending reads, and refreshes completed results',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'taskchef-analytics-poll-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 let finish;let reads=0;
 const server=new McpServer({name:'usage-poll-test',version:'1'});
 registerTaskChefApp(server,{settingsPath:join(temp,'settings.json'),createScanner:()=>({close(){},usageHistory:()=>{reads++;return new Promise(resolve=>{finish=resolve;});}}),getSettingsUrl:async()=>null});
 const client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const args={range:'mtd',timeZone:'UTC'};
 const call=force=>client.callTool({name:'taskchef_app_usage',arguments:{...args,...(force?{force:true}:{})}});
 assert.equal((await call(true)).structuredContent.loading,true);assert.equal(reads,1);
 assert.equal((await call(false)).structuredContent.loading,true);assert.equal(reads,1);
 finish([]);await settled(()=>call(false));
 assert.equal((await call(false)).structuredContent.samples,0);
 assert.equal((await call(true)).structuredContent.refreshing,true);assert.equal(reads,2);finish([]);await settled(()=>call(false));
});


test('all date ranges share a history snapshot, expose measured progress, and keep stale data during refresh',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'taskchef-history-cache-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 let finish;let progress;let reads=0;let now=Date.now();t.mock.method(Date,'now',()=>now);
 const server=new McpServer({name:'history-cache-test',version:'1'});
 registerTaskChefApp(server,{settingsPath:join(temp,'settings.json'),createScanner:()=>({close(){},usageHistory:({onProgress})=>{reads++;progress=onProgress;onProgress({completed:0,total:10});return new Promise(resolve=>{finish=resolve;});}}),getSettingsUrl:async()=>null});
 const client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const call=(range='mtd',force=false)=>client.callTool({name:'taskchef_app_usage',arguments:{range,timeZone:'UTC',...(force?{force:true}:{})}});
 assert.equal((await call()).structuredContent.loading,true);assert.equal(reads,1);
 progress({completed:4,total:10});assert.deepEqual((await call('7d')).structuredContent.progress,{completed:4,total:10});assert.equal(reads,1);
 finish([]);await settled(()=>call());
 for(const range of ['mtd','7d','last-month','90d','mtd']){const result=(await call(range)).structuredContent;assert.ok(Array.isArray(result.days));assert.equal(result.loading,undefined);assert.equal(result.refreshing,undefined);}
 assert.equal(reads,1);
 now+=61_000;const stale=(await call('30d')).structuredContent;assert.equal(stale.refreshing,true);assert.equal(stale.days.length,30);assert.equal(reads,2);
 assert.equal((await call('last-month')).structuredContent.refreshing,true);assert.equal(reads,2);
 finish([]);await settled(()=>call());
 assert.equal((await call('7d')).structuredContent.refreshing,undefined);
 assert.equal((await call('7d',true)).structuredContent.refreshing,true);assert.equal(reads,3);finish([]);await settled(()=>call());
});


test('Refresh during a pending history read queues one follow-up without making range changes rescan',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'taskchef-history-refresh-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 let finish;let reads=0;const server=new McpServer({name:'queued-refresh',version:'1'});
 registerTaskChefApp(server,{settingsPath:join(temp,'settings.json'),createScanner:()=>({close(){},usageHistory:()=>{reads++;return new Promise(resolve=>{finish=resolve;});}}),getSettingsUrl:async()=>null});
 const client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const call=(range='mtd',force=false)=>client.callTool({name:'taskchef_app_usage',arguments:{range,timeZone:'UTC',...(force?{force:true}:{})}});
 assert.equal((await call()).structuredContent.loading,true);assert.equal(reads,1);
 await call('7d',true);await call('mtd',true);await call('last-month');assert.equal(reads,1);
 finish([]);await until(()=>reads===2);assert.equal(reads,2);
 assert.equal((await call('last-month')).structuredContent.refreshing,true);assert.equal(reads,2);
 finish([]);await settled(()=>call());assert.equal((await call()).structuredContent.refreshing,undefined);assert.equal(reads,2);
});

test('Rescan queues a full rebuild behind an incremental scan and polling does not repeat it', async t => {
 const temp=await mkdtemp(join(tmpdir(),'taskchef-rescan-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 let finish;const scans=[];const server=new McpServer({name:'rescan',version:'1'});
 registerTaskChefApp(server,{settingsPath:join(temp,'settings.json'),createScanner:()=>({close(){},usageHistory:({rescan})=>{scans.push(rescan);return new Promise(resolve=>{finish=resolve;});}}),getSettingsUrl:async()=>null});
 const client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const call=(args={})=>client.callTool({name:'taskchef_app_usage',arguments:{range:'mtd',timeZone:'UTC',...args}});
 await call();await call({rescan:true});await call({range:'7d'});assert.deepEqual(scans,[false]);
 finish([]);await until(()=>scans.length===2);assert.deepEqual(scans,[false,true]);
 await call();finish([]);await settled(()=>call());assert.deepEqual(scans,[false,true]);
 await call({rescan:true});assert.deepEqual(scans,[false,true,true]);finish([]);await settled(()=>call());
});

async function usageServer(t, settingsPath, scanner) {
 const server=new McpServer({name:'disk-history',version:'1'});
 registerTaskChefApp(server,{settingsPath,createScanner:()=>({close(){},...scanner}),getSettingsUrl:async()=>null});
 const client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 let closed=false;const close=async()=>{if(!closed){closed=true;await client.close();await server.close();}};t.after(close);
 return {client,close,call:(args={})=>client.callTool({name:'taskchef_app_usage',arguments:{range:'7d',timeZone:'UTC',...args}})};
}
const historyFixture = (now, tokens=100) => [{project:{id:'a',name:'Alpha',path:'/alpha'},usage:{partial:false,analyticsPartial:false,
 timeline:[{time:now-1000,tokens:{total_tokens:tokens,input_tokens:80,cached_input_tokens:20,output_tokens:20},costUsd:2,samples:1,partial:false,costPartial:false}],
 weeklyLimits:[{id:'codex',name:null,time:now-1000,remainingPercent:89,resetsAt:now+86400000}]}}];

test('a restarted server serves disk history including weekly readings before a shared background scan finishes',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'taskchef-disk-history-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const settingsPath=join(temp,'settings.json'),now=Date.now();
 const first=await usageServer(t,settingsPath,{usageHistory:async()=>historyFixture(now)});
 const initial=await settled(()=>first.call());await first.close();
 let finish,reads=0;
 const second=await usageServer(t,settingsPath,{usageHistory:()=>{reads++;return new Promise(resolve=>{finish=resolve;});}});
 const responses=await Promise.all([second.call(),second.call({range:'mtd'}),second.call({timeZone:'Asia/Singapore'})]);
 for(const {structuredContent:data} of responses) {
  assert.equal(data.loading,undefined);assert.equal(data.refreshing,true);assert.equal(data.totals.tokens,100);
  assert.equal(data.currentWeeklyLimit.remainingPercent,89);assert.equal(data.weeklyLimits[0].remainingPercent,89);
  assert.equal(data.updatedAt,initial.updatedAt);
 }
 assert.equal(reads,1);
 finish(historyFixture(Date.now(),200));const updated=await settled(()=>second.call());assert.equal(updated.totals.tokens,200);
 await second.close();
 const third=await usageServer(t,settingsPath,{usageHistory:async()=>{throw new Error('offline');}});
 const saved=(await third.call()).structuredContent;assert.equal(saved.totals.tokens,200);
 const failed=await settled(()=>third.call());assert.equal(failed.totals.tokens,200);assert.match(failed.refreshError,/Background refresh failed/);
 // A failed refresh must leave the last successful disk snapshot intact.
 await third.close();
 const fourth=await usageServer(t,settingsPath,{usageHistory:async()=>{throw new Error('offline');}});
 assert.equal((await fourth.call()).structuredContent.totals.tokens,200);await settled(()=>fourth.call());
});

test('disk history is isolated by Codex home but shared across visibility changes',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'taskchef-disk-scope-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const settingsPath=join(temp,'settings.json');
 const first=await usageServer(t,settingsPath,{codexHome:'/one',usageHistory:async()=>historyFixture(Date.now())});await settled(()=>first.call());await first.close();
 let finish;
 const second=await usageServer(t,settingsPath,{codexHome:'/two',usageHistory:()=>new Promise(resolve=>{finish=resolve;})});
 assert.equal((await second.call()).structuredContent.loading,true);finish([]);await settled(()=>second.call());await second.close();
 let reads=0;
 const third=await usageServer(t,settingsPath,{codexHome:'/one',usageHistory:()=>{reads++;return new Promise(resolve=>{finish=resolve;});}});
 assert.equal((await third.call()).structuredContent.totals.tokens,100);
 await until(async()=>typeof finish==='function'&&reads===1);
 for(const value of [true,false]) {
  await third.client.callTool({name:'taskchef_settings_update',arguments:{set:{showCli:value,showExec:value,showArchived:value}}});
  assert.equal((await third.call()).structuredContent.totals.tokens,100);
  assert.equal(reads,1);
 }
 finish(historyFixture(Date.now()));await settled(()=>third.call());
});

test('all-source history does not hydrate an old visibility-filtered snapshot',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'taskchef-disk-legacy-scope-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const {writeUsageHistory}=await import('../src/usage-history-cache.js');
 await writeUsageHistory(join(temp,'cache','usage-history'),JSON.stringify(['/one',false,false]),historyFixture(Date.now()),Date.now());
 let finish;
 const app=await usageServer(t,join(temp,'settings.json'),{codexHome:'/one',usageHistory:()=>new Promise(resolve=>{finish=resolve;})});
 assert.equal((await app.call()).structuredContent.loading,true);
 await until(async()=>typeof finish==='function');finish(historyFixture(Date.now()));
 assert.equal((await settled(()=>app.call())).totals.tokens,100);
});

test('corrupt or incompatible snapshots rebuild, and an unwritable cache does not break usage',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'taskchef-disk-corrupt-'));t.after(()=>rm(temp,{recursive:true,force:true}));
 const {readdir}=await import('node:fs/promises');
 const settingsPath=join(temp,'settings.json');
 const first=await usageServer(t,settingsPath,{usageHistory:async()=>historyFixture(Date.now())});await settled(()=>first.call());await first.close();
 const directory=join(temp,'cache','usage-history'),[name]=await readdir(directory),path=join(directory,name);
 for(const content of ['broken JSON',JSON.stringify({version:999,families:[]}),JSON.stringify({version:1,scope:'wrong',savedAt:Date.now(),families:[]})]) {
  await writeFile(path,content);let finish;
  const next=await usageServer(t,settingsPath,{usageHistory:()=>new Promise(resolve=>{finish=resolve;})});
  assert.equal((await next.call()).structuredContent.loading,true);finish([]);await settled(()=>next.call());await next.close();
 }
 await rm(directory,{recursive:true});await writeFile(directory,'not a directory');
 const uncached=await usageServer(t,settingsPath,{usageHistory:async()=>historyFixture(Date.now())});
 const data=await settled(()=>uncached.call());assert.equal(data.totals.tokens,100);assert.equal(data.refreshError,undefined);
});
