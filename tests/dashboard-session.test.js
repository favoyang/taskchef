import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDashboardManager, createDashboardServer, initializeWorkspace, readDashboardIdentity } from "../index.js";
import { DASHBOARD_CONTROL_SESSION_PATH, DASHBOARD_CONTROL_SHUTDOWN_PATH } from "../src/dashboard-control.js";
import { launchDashboardSession, requestDashboardJson } from "../src/dashboard-manager.js";
import { runDashboardSessionProcess } from "../src/dashboard-session-process.js";
import { createDashboardSessionLease, processIsAlive, validSessionPid } from "../src/dashboard-session.js";

async function workspaceFixture(label = "dispatcher") {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-session-"));
  const workspace = path.join(root, label);
  await initializeWorkspace(workspace);
  return workspace;
}

async function unusedPort(host = "127.0.0.1") {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, host, resolve); });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

function inProcessSessionHarness() {
  const runtimes = [];
  const registrations = [];
  return {
    runtimes,
    registrations,
    async launchSession(options) {
      const runtime = await runDashboardSessionProcess({
        ...options,
        createLease: ({ initialPid }) => {
          const pids = new Set([initialPid]);
          return { register(pid) { pids.add(pid); registrations.push(pid); }, close() {}, get sessionCount() { return pids.size; } };
        },
        processObject: new EventEmitter(),
      });
      runtimes.push(runtime);
      return { pid: process.pid };
    },
    async close() { await Promise.allSettled(runtimes.map((runtime) => runtime.close())); },
  };
}

function manager(workspace, port, harness, options = {}) {
  return createDashboardManager({ workspace, port, sessionPid: process.pid,
    launchSession: harness.launchSession, ...options });
}

test("session manager rejects ephemeral port zero", async () => {
  const workspace = await workspaceFixture();
  assert.throws(() => createDashboardManager({ workspace, port: 0 }),
    /port must be an integer from 1 to 65535/);
});

test("detached launcher reports ready only after the child confirms availability", async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 777, connected: true });
  child.disconnect = () => { child.connected = false; };
  child.unref = () => {};
  let spawnOptions;
  const launching = launchDashboardSession({ workspace: "/private/tmp/taskchef-ready-test",
    host: "127.0.0.1", port: 4321, sessionPid: 123,
    spawnProcess(_processPath, _args, options) { spawnOptions = options; return child; } });
  let resolved = false;
  void launching.then(() => { resolved = true; });
  child.emit("spawn");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal("TASKCHEF_DASHBOARD_SECRET" in spawnOptions.env, false);
  assert.equal("TASKCHEF_DASHBOARD_SESSION_PIDS" in spawnOptions.env, false);
  child.emit("message", { type: "ready", port: 4321 });
  assert.deepEqual(await launching, { pid: 777, port: 4321 });
});

test("detached launcher timeout cannot race a late ready message", async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 778, connected: true });
  child.disconnect = () => { child.connected = false; };
  child.unref = () => {};
  child.send = (_message, callback) => { child.emit("message", { type: "ready", port: 4322 }); setImmediate(callback); };
  await assert.rejects(launchDashboardSession({ workspace: "/private/tmp/taskchef-timeout-test",
    host: "127.0.0.1", port: 4322, sessionPid: 123, readyTimeoutMs: 1,
    spawnProcess: () => child }), (error) => error?.code === "TASKCHEF_DASHBOARD_START_TIMEOUT");
});

test("a truncated control response rejects instead of remaining pending", async (t) => {
  const port = await unusedPort();
  const server = http.createServer((_request, response) => {
    response.writeHead(202, { "Content-Type": "application/json", "Content-Length": "100" });
    response.write("{}");
    setTimeout(() => response.destroy(), 10);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(requestDashboardJson({ host: "127.0.0.1", port,
    path: DASHBOARD_CONTROL_SHUTDOWN_PATH, action: "shutdown", body: {}, timeoutMs: 100 }),
    /control response was interrupted/);
});

test("session lease retains live same-version Codex sessions and expires after grace", async () => {
  let now = 1_000; const live = new Set([101, 202]); let expiryCount = 0;
  const lease = createDashboardSessionLease({ initialPid: 101, checkIntervalMs: 60_000,
    exitGraceMs: 50, isAlive: (pid) => live.has(pid), now: () => now,
    onExpire: () => { expiryCount += 1; } });
  lease.register(202); live.delete(101); lease.tick(); assert.equal(lease.sessionCount, 1);
  live.delete(202); lease.tick(); now += 49; lease.tick(); assert.equal(expiryCount, 0);
  now += 1; lease.tick(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(expiryCount, 1);
  assert.throws(() => lease.register(303), (error) => error?.code === "TASKCHEF_DASHBOARD_SESSION_RETIRING");
  lease.close();
});

test("session PID validation and liveness probes remain bounded", () => {
  assert.equal(validSessionPid(2), true); assert.equal(validSessionPid(1), false);
  assert.equal(validSessionPid(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(processIsAlive(42, { kill(pid, signal) { assert.equal(pid, 42); assert.equal(signal, 0); } }), true);
  assert.equal(processIsAlive(42, { kill() { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }), false);
});

test("startup, exact reuse, and concurrent activation converge on one reachable dashboard", async (t) => {
  const workspace = await workspaceFixture(); const port = await unusedPort();
  const harness = inProcessSessionHarness(); t.after(() => harness.close());
  const first = manager(workspace, port, harness); const second = manager(workspace, port, harness);
  const results = await Promise.all([first.ensure(), first.ensure(), second.ensure()]);
  assert.deepEqual(results.map((value) => value.action).sort(), ["reused", "reused", "started"]);
  assert.ok(harness.registrations.includes(process.pid));
  const identity = await readDashboardIdentity({ port });
  assert.equal(identity.workspace, await realpath(workspace));
  assert.equal((await readDashboardIdentity({ port })).service, "taskchef-dashboard");
});

test("an exact current same-workspace standalone dashboard is reused after final health verification", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const server = await createDashboardServer({ workspace, port, launcher: "standalone" });
  t.after(() => server.close());
  let launches = 0;
  const result = await createDashboardManager({ workspace, port,
    launchSession: async () => { launches += 1; } }).ensure();
  assert.equal(result.action, "reused");
  assert.equal(result.launcher, "standalone");
  assert.equal(launches, 0);
  assert.equal((await readDashboardIdentity({ port })).launcher, "standalone");
});

test("a recognized older dashboard shuts down and restarts without transferring leases", async (t) => {
  const workspace = await workspaceFixture(); const port = await unusedPort();
  const harness = inProcessSessionHarness(); t.after(() => harness.close());
  const oldManager = manager(workspace, port, harness, { taskchefVersion: "7.22.1", serverVersion: "3" });
  const newManager = manager(workspace, port, harness, { taskchefVersion: "7.23.0", serverVersion: "4" });
  assert.equal((await oldManager.ensure()).action, "started");
  assert.equal((await newManager.ensure()).action, "started");
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.23.0");
  await assert.rejects(oldManager.ensure(), /newer TaskChef 7\.23\.0; refusing to downgrade/);
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.23.0");
});

test("a delayed older-version shutdown cannot retire a replacement listener", async (t) => {
  const workspace = await workspaceFixture(); const port = await unusedPort();
  let active = await createDashboardServer({ workspace, port, taskchefVersion: "7.0.0",
    serverVersion: "1", launcher: "session", control: { onSession() {}, onShutdown() {} } });
  let replacementShutdowns = 0;
  t.after(async () => { await active.close().catch(() => {}); });
  const requestJson = async (options) => {
    if (options.path === DASHBOARD_CONTROL_SHUTDOWN_PATH) {
      await active.close();
      active = await createDashboardServer({ workspace, port, taskchefVersion: "9.0.0",
        serverVersion: "5", launcher: "session", control: {
          onSession() {},
          onShutdown() { replacementShutdowns += 1; },
        } });
    }
    return requestDashboardJson(options);
  };
  await assert.rejects(createDashboardManager({ workspace, port, taskchefVersion: "8.0.0",
    serverVersion: "4", requestJson }).ensure(), /newer TaskChef 9\.0\.0; refusing to downgrade/);
  assert.equal(replacementShutdowns, 0);
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "9.0.0");
});

test("unknown, malformed, different-workspace, and legacy-control listeners stay untouched", async (t) => {
  const workspace = await workspaceFixture();
  for (const identity of [
    { service: "other" },
    { schemaVersion: 1, service: "taskchef-dashboard", taskchefVersion: "7.0.0", serverVersion: "1", workspace: "/elsewhere", launcher: "session" },
  ]) {
    const port = await unusedPort(); let requests = 0;
    const server = http.createServer((_request, response) => { requests += 1; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(identity)); });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await assert.rejects(createDashboardManager({ workspace, port }).ensure(), /port conflict/);
    assert.equal(requests, 1);
  }
  const port = await unusedPort(); let shutdowns = 0;
  const canonicalWorkspace = await realpath(workspace);
  const legacy = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") response.end(JSON.stringify({ schemaVersion: 1,
      service: "taskchef-dashboard", taskchefVersion: "7.0.0", serverVersion: "1",
      workspace: canonicalWorkspace, launcher: "session" }));
    else { shutdowns += 1; response.statusCode = 403; response.end(JSON.stringify({ accepted: false })); }
  });
  await new Promise((resolve) => legacy.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => legacy.close(resolve)));
  await assert.rejects(createDashboardManager({ workspace, port, taskchefVersion: "8.4.0" }).ensure(),
    /recognized older TaskChef 7\.0\.0 listener that refused graceful shutdown/);
  assert.equal(shutdowns, 1);
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.0.0");
});

test("graceful replacement is bounded when an older listener does not release its port", async (t) => {
  const workspace = await workspaceFixture(); const port = await unusedPort();
  const server = await createDashboardServer({ workspace, port, taskchefVersion: "7.0.0",
    serverVersion: "1", launcher: "session", control: { onSession() {}, onShutdown() {} } });
  t.after(() => server.close());
  await assert.rejects(createDashboardManager({ workspace, port, taskchefVersion: "8.0.0",
    shutdownTimeoutMs: 40 }).ensure(), /did not release the port within 40ms/);
});

test("control endpoints reject ordinary cross-site and malformed browser requests", async (t) => {
  const workspace = await workspaceFixture(); const port = await unusedPort();
  let shutdowns = 0; const sessions = [];
  const server = await createDashboardServer({ workspace, port, launcher: "session",
    control: { onShutdown() { shutdowns += 1; }, onSession(pid) { sessions.push(pid); } } });
  t.after(() => server.close());
  const crossSite = await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: DASHBOARD_CONTROL_SHUTDOWN_PATH,
      method: "POST", headers: { Host: `127.0.0.1:${port}`, Origin: "https://example.com",
        "Content-Type": "application/json", "X-TaskChef-Control": "shutdown" } }, resolve);
    request.on("error", reject); request.end(JSON.stringify({ reason: "version-replacement" }));
  });
  assert.equal(crossSite.statusCode, 403); crossSite.resume(); assert.equal(shutdowns, 0);
  const mismatched = await requestDashboardJson({ host: "127.0.0.1", port,
    path: DASHBOARD_CONTROL_SHUTDOWN_PATH, action: "shutdown",
    body: { reason: "version-replacement", expectedIdentity: { ...server.identity, workspace: "/elsewhere" } },
    timeoutMs: 500 });
  assert.equal(mismatched.statusCode, 409); assert.equal(shutdowns, 0);
  const mismatchedSession = await requestDashboardJson({ host: "127.0.0.1", port,
    path: DASHBOARD_CONTROL_SESSION_PATH, action: "session",
    body: { pid: process.pid, expectedIdentity: { ...server.identity, taskchefVersion: "0.0.0" } },
    timeoutMs: 500 });
  assert.equal(mismatchedSession.statusCode, 409); assert.deepEqual(sessions, []);
  const valid = await requestDashboardJson({ host: "127.0.0.1", port,
    path: DASHBOARD_CONTROL_SESSION_PATH, action: "session",
    body: { pid: process.pid, expectedIdentity: server.identity }, timeoutMs: 500 });
  assert.equal(valid.statusCode, 200); assert.deepEqual(sessions, [process.pid]);
});

test("startup cancellation closes a server returned after createServer was deferred", async () => {
  const workspace = await workspaceFixture();
  const controller = new AbortController();
  let serverEntered;
  let releaseServer;
  const entered = new Promise((resolve) => { serverEntered = resolve; });
  const serverGate = new Promise((resolve) => { releaseServer = resolve; });
  let serverClosed = 0;
  const starting = runDashboardSessionProcess({ workspace, port: 3210, sessionPid: process.pid,
    signal: controller.signal, processObject: new EventEmitter(),
    createServer: async () => {
      serverEntered();
      await serverGate;
      return { async close() { serverClosed += 1; } };
    } });
  await entered;
  controller.abort();
  releaseServer();
  await assert.rejects(starting,
    (error) => error?.code === "TASKCHEF_DASHBOARD_START_TIMEOUT");
  assert.equal(serverClosed, 1);
});

test("reuse waits for session registration and a final successful health probe", async () => {
  const workspace = await workspaceFixture(); const canonical = await realpath(workspace);
  const identity = { schemaVersion: 1, service: "taskchef-dashboard", taskchefVersion: "8.3.0",
    serverVersion: "4", workspace: canonical, launcher: "session" };
  let reads = 0; let launches = 0;
  const manager = createDashboardManager({ workspace, port: 3210, taskchefVersion: "8.3.0",
    serverVersion: "4", readIdentity: async () => {
      reads += 1;
      if (reads === 2) throw Object.assign(new Error("closed"), { code: "ECONNREFUSED" });
      return identity;
    }, requestJson: async () => ({ statusCode: 200, value: { accepted: true } }),
    launchSession: async () => { launches += 1; } });
  assert.equal((await manager.ensure()).action, "started");
  assert.equal(launches, 1);
  assert.ok(reads >= 4, "startup is verified again after the failed reuse probe");
});
