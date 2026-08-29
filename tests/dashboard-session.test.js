import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, realpath } from "node:fs/promises";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDashboardManager,
  createDashboardServer,
  initializeWorkspace,
  readDashboardIdentity,
} from "../index.js";
import {
  DASHBOARD_CONTROL_CHALLENGE_PATH,
  DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH,
  DASHBOARD_CONTROL_HANDOFF_PATH,
  DASHBOARD_CONTROL_SESSION_PATH,
  DASHBOARD_CONTROL_SHUTDOWN_PATH,
  DASHBOARD_HANDOFF_FILE,
  DASHBOARD_OWNER_FILE,
  createDashboardControlNonce,
  dashboardControlProof,
  dashboardHandoffMetadata,
  dashboardOwnerMetadata,
  readDashboardHandoff,
  readDashboardOwner,
  verifyDashboardControlProof,
  writeDashboardHandoff,
  writeDashboardOwner,
} from "../src/dashboard-ownership.js";
import { createDashboardControlReplayCache } from "../src/dashboard.js";
import { launchDashboardSession, requestDashboardJson } from "../src/dashboard-manager.js";
import { runDashboardSessionProcess } from "../src/dashboard-session-process.js";
import { DASHBOARD_SERVER_VERSION, TASKCHEF_VERSION } from "../src/version.js";
import {
  MAX_DASHBOARD_SESSION_PIDS,
  createDashboardSessionLease,
  processIsAlive,
  validSessionPid,
} from "../src/dashboard-session.js";

async function workspaceFixture(label = "dispatcher") {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-session-"));
  const workspace = path.join(root, label);
  await initializeWorkspace(workspace);
  return workspace;
}

async function unusedPort(host = "127.0.0.1") {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, host, resolve);
  });
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
          return {
            register(pid) { pids.add(pid); registrations.push(pid); },
            snapshot() { return [...pids]; },
            close() {},
            get sessionCount() { return pids.size; },
          };
        },
        processObject: new EventEmitter(),
      });
      runtimes.push(runtime);
      return { pid: process.pid };
    },
    async close() {
      await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    },
  };
}

function manager(workspace, port, harness, options = {}) {
  return createDashboardManager({
    workspace,
    port,
    sessionPid: process.pid,
    launchSession: harness.launchSession,
    ...options,
  });
}

test("session manager rejects ephemeral port zero instead of losing its detached listener", async () => {
  const workspace = await workspaceFixture();
  assert.throws(
    () => createDashboardManager({ workspace, port: 0 }),
    /port must be an integer from 1 to 65535/,
  );
});

test("detached launcher waits for owner-published readiness instead of OS spawn", async () => {
  const child = new EventEmitter();
  child.pid = 777;
  child.connected = true;
  child.disconnect = () => { child.connected = false; };
  child.unref = () => {};
  let spawnOptions;
  const launching = launchDashboardSession({
    workspace: "/private/tmp/taskchef-ready-test",
    host: "127.0.0.1",
    port: 4321,
    secret: "1".repeat(64),
    sessionPid: 123,
    spawnProcess(_processPath, _args, options) {
      spawnOptions = options;
      return child;
    },
  });
  let resolved = false;
  void launching.then(() => { resolved = true; });
  child.emit("spawn");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.deepEqual(spawnOptions.stdio, ["ignore", "ignore", "ignore", "ipc"]);
  child.emit("message", { type: "ready", port: 4321 });
  assert.deepEqual(await launching, { pid: 777, port: 4321 });
  assert.equal(child.connected, false);
});

test("detached launcher rejects irrevocably before timeout cancellation can race readiness", async () => {
  const child = new EventEmitter();
  child.pid = 778;
  child.connected = true;
  child.disconnect = () => { child.connected = false; };
  child.unref = () => {};
  child.send = (_message, callback) => {
    child.emit("message", { type: "ready", port: 4322 });
    setImmediate(callback);
  };
  const launching = launchDashboardSession({
    workspace: "/private/tmp/taskchef-timeout-test",
    host: "127.0.0.1",
    port: 4322,
    secret: "1".repeat(64),
    sessionPid: 123,
    readyTimeoutMs: 1,
    spawnProcess: () => child,
  });
  await assert.rejects(
    launching,
    (error) => error?.code === "TASKCHEF_DASHBOARD_START_TIMEOUT",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.connected, false);
});

test("session lease retains any live registered Codex session and expires after grace", async () => {
  let now = 1_000;
  const live = new Set([101, 202]);
  let expiryCount = 0;
  const lease = createDashboardSessionLease({
    initialPid: 101,
    checkIntervalMs: 60_000,
    exitGraceMs: 50,
    isAlive: (pid) => live.has(pid),
    now: () => now,
    onExpire: () => { expiryCount += 1; },
  });
  try {
    lease.register(202);
    live.delete(101);
    lease.tick();
    assert.equal(lease.sessionCount, 1);
    assert.equal(expiryCount, 0);
    live.delete(202);
    lease.tick();
    now += 49;
    lease.tick();
    assert.equal(expiryCount, 0);
    now += 1;
    lease.tick();
    assert.throws(
      () => lease.register(303),
      (error) => error?.code === "TASKCHEF_DASHBOARD_SESSION_RETIRING",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(expiryCount, 1);
    lease.tick();
    assert.equal(expiryCount, 1);
  } finally {
    lease.close();
  }
});

test("session PID validation and exact PID liveness are bounded", () => {
  assert.equal(validSessionPid(2), true);
  assert.equal(validSessionPid(1), false);
  assert.equal(validSessionPid(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(processIsAlive(42, { kill(pid, signal) {
    assert.equal(pid, 42);
    assert.equal(signal, 0);
  } }), true);
  assert.equal(processIsAlive(42, { kill() { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }), false);
  assert.equal(processIsAlive(42, { kill() { throw Object.assign(new Error("private"), { code: "EPERM" }); } }), true);
});

test("dashboard control replay cache is bounded and expires only after its window", () => {
  let now = 1_000;
  const cache = createDashboardControlReplayCache({ maximum: 2, ttlMs: 50, now: () => now });
  assert.equal(cache.accept("one"), true);
  assert.equal(cache.accept("two"), true);
  assert.equal(cache.accept("one"), false);
  assert.equal(cache.accept("three"), false);
  assert.equal(cache.size, 2);
  now += 50;
  assert.equal(cache.accept("three"), true);
  assert.equal(cache.size, 1);
});

test("MCP activation starts one session dashboard and manager close leaves it available", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const first = manager(workspace, port, harness);
  const second = manager(workspace, port, harness);
  const results = await Promise.all([first.ensure(), first.ensure(), second.ensure()]);
  assert.deepEqual(results.map((value) => value.action).sort(), ["reused", "reused", "started"]);
  assert.ok(results.every((value) => value.launcher === "session"));
  assert.ok(harness.registrations.includes(process.pid));
  assert.equal((await readDashboardIdentity({ port })).workspace, await realpath(workspace));
  await Promise.all([first.close(), second.close()]);
  assert.equal((await readDashboardIdentity({ port })).launcher, "session");
});

test("authenticated older-version handoff starts the installed version without downgrade", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const oldManager = manager(workspace, port, harness, { taskchefVersion: "7.22.1", serverVersion: "3" });
  const newManager = manager(workspace, port, harness, { taskchefVersion: "7.23.0", serverVersion: "4" });
  assert.equal((await oldManager.ensure()).action, "started");
  const ownerStat = await lstat(path.join(workspace, DASHBOARD_OWNER_FILE));
  assert.equal(ownerStat.mode & 0o777, 0o600);
  assert.equal((await newManager.ensure()).action, "started");
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.23.0");
  await assert.rejects(oldManager.ensure(), /unknown, stale, different-workspace, or differently launched/);
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.23.0");
});

test("all lost commit responses recover after the old listener releases", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  let shutdownEntered;
  let releaseShutdown;
  const entered = new Promise((resolve) => { shutdownEntered = resolve; });
  const shutdownGate = new Promise((resolve) => { releaseShutdown = resolve; });
  const oldRuntimes = [];
  const launchOldSession = async (options) => {
    const runtime = await runDashboardSessionProcess({
      ...options,
      createServer: (serverOptions) => {
        const close = serverOptions.control.onShutdown;
        return createDashboardServer({
          ...serverOptions,
          control: {
            ...serverOptions.control,
            onShutdown: async () => {
              shutdownEntered();
              await shutdownGate;
              return close();
            },
          },
        });
      },
      processObject: new EventEmitter(),
    });
    oldRuntimes.push(runtime);
    return { pid: process.pid };
  };
  const replacementHarness = inProcessSessionHarness();
  t.after(async () => {
    releaseShutdown();
    await Promise.allSettled([
      ...oldRuntimes.map((runtime) => runtime.close()),
      replacementHarness.close(),
    ]);
  });
  const oldManager = createDashboardManager({
    workspace,
    port,
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    sessionPid: process.pid,
    launchSession: launchOldSession,
  });
  const otherSession = createDashboardManager({
    workspace,
    port,
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    sessionPid: process.ppid,
    launchSession: launchOldSession,
  });
  await oldManager.ensure();
  await otherSession.ensure();
  let droppedCommitResponses = 0;
  const current = createDashboardManager({
    workspace,
    port,
    taskchefVersion: "7.23.0",
    sessionPid: process.pid,
    launchSession: replacementHarness.launchSession,
    requestJson: async (options) => {
      const response = await requestDashboardJson(options);
      if (options.path === DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH) {
        droppedCommitResponses += 1;
        return null;
      }
      return response;
    },
  });
  let settled = false;
  const ensuring = current.ensure().finally(() => { settled = true; });
  await entered;
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  assert.equal(settled, false);
  releaseShutdown();
  assert.equal((await ensuring).action, "started");
  assert.equal(droppedCommitResponses, 3);
  assert.deepEqual(
    new Set(replacementHarness.runtimes.at(-1).lease.snapshot()),
    new Set([process.pid, process.ppid]),
  );
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.23.0");
});

test("late recovery after finalization preserves leases through delayed shutdown", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "f".repeat(64);
  const leases = new Set([process.ppid]);
  let shutdownEntered;
  let releaseShutdown;
  const entered = new Promise((resolve) => { shutdownEntered = resolve; });
  const shutdownGate = new Promise((resolve) => { releaseShutdown = resolve; });
  let oldServer;
  oldServer = await createDashboardServer({
    workspace,
    port,
    launcher: "session",
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    control: {
      secret,
      onShutdown: async () => {
        shutdownEntered();
        await shutdownGate;
        await oldServer.close();
      },
      onSession: (pid) => { leases.add(pid); },
      onHandoff: (pid) => { leases.add(pid); return [...leases]; },
      onHandoffFinalized: ({ id, pids }) => writeDashboardHandoff(
        canonicalWorkspace,
        dashboardHandoffMetadata({
          workspace: canonicalWorkspace,
          host: "127.0.0.1",
          port,
          taskchefVersion: "7.22.1",
          serverVersion: "3",
          id,
          pids,
          secret,
        }),
      ),
    },
  });
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    workspace: canonicalWorkspace,
    host: "127.0.0.1",
    port,
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    launcher: "session",
    secret,
  }));
  const replacementHarness = inProcessSessionHarness();
  t.after(async () => {
    releaseShutdown();
    await Promise.allSettled([oldServer.close(), replacementHarness.close()]);
  });

  const prepareNonce = createDashboardControlNonce();
  const prepare = await requestDashboardJson({
    host: "127.0.0.1",
    port,
    path: DASHBOARD_CONTROL_HANDOFF_PATH,
    method: "POST",
    body: {
      pid: process.pid,
      nonce: prepareNonce,
      proof: dashboardControlProof(secret, `handoff:${process.pid}`, prepareNonce),
    },
    timeoutMs: 750,
  });
  const commitNonce = createDashboardControlNonce();
  const commit = await requestDashboardJson({
    host: "127.0.0.1",
    port,
    path: DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH,
    method: "POST",
    body: {
      id: prepare.value.id,
      nonce: commitNonce,
      proof: dashboardControlProof(secret, `handoff-commit:${prepare.value.id}`, commitNonce),
    },
    timeoutMs: 750,
  });
  assert.equal(commit.statusCode, 202);

  const recovering = manager(workspace, port, replacementHarness, {
    taskchefVersion: "7.23.0",
    ownerAuthTimeoutMs: 5_000,
  });
  let settled = false;
  const recovery = recovering.ensure().finally(() => { settled = true; });
  await entered;
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  assert.equal(settled, false);
  releaseShutdown();
  assert.equal((await recovery).action, "started");
  assert.deepEqual(
    new Set(replacementHarness.runtimes.at(-1).lease.snapshot()),
    new Set([process.pid, process.ppid]),
  );
});

test("authenticated handoff accepts a prior MCP-owned dashboard", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "a".repeat(64);
  let legacy;
  legacy = await createDashboardServer({
    workspace,
    port,
    launcher: "mcp",
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    control: { secret, onShutdown: () => legacy.close() },
  });
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    workspace: canonicalWorkspace,
    host: "127.0.0.1",
    port,
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    launcher: "mcp",
    secret,
  }));
  const harness = inProcessSessionHarness();
  t.after(() => Promise.allSettled([legacy.close(), harness.close()]));
  const current = manager(workspace, port, harness, { taskchefVersion: "7.23.0" });
  assert.equal((await current.ensure()).action, "started");
  assert.deepEqual(await readDashboardIdentity({ port }).then((value) => [value.launcher, value.taskchefVersion]), [
    "session", "7.23.0",
  ]);
});

test("same-version incompatible listener is not treated as an older handoff target", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "9".repeat(64);
  let shutdownCount = 0;
  const listener = await createDashboardServer({
    workspace,
    port,
    launcher: "mcp",
    taskchefVersion: "7.23.0",
    serverVersion: "3",
    control: { secret, onShutdown: async () => { shutdownCount += 1; } },
  });
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    workspace: canonicalWorkspace,
    host: "127.0.0.1",
    port,
    taskchefVersion: "7.23.0",
    serverVersion: "3",
    launcher: "mcp",
    secret,
  }));
  t.after(() => listener.close());
  const harness = inProcessSessionHarness();
  const current = manager(workspace, port, harness, {
    taskchefVersion: "7.23.0",
    serverVersion: "4",
  });
  await assert.rejects(current.ensure(), /unknown, stale, different-workspace, or differently launched/);
  assert.equal(shutdownCount, 0);
  assert.equal((await readDashboardIdentity({ port })).serverVersion, "3");
});

test("session control rejects missing, bad, and replayed registration credentials", async (t) => {
  const workspace = await workspaceFixture();
  const secret = "b".repeat(64);
  const registrations = [];
  const server = await createDashboardServer({
    workspace,
    port: 0,
    launcher: "session",
    control: {
      secret,
      onShutdown: async () => {},
      onSession: async (pid) => registrations.push(pid),
      onHandoff: async (pid) => [pid],
    },
  });
  t.after(() => server.close());
  const post = (body) => fetch(`${server.origin}${DASHBOARD_CONTROL_SESSION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ pid: 12, nonce: "c".repeat(48), proof: "d".repeat(64) })).status, 403);
  const nonce = createDashboardControlNonce();
  const body = { pid: 12, nonce, proof: dashboardControlProof(secret, "session:12", nonce) };
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 409);
  assert.deepEqual(registrations, [12]);
});

test("manager rejects an unsigned registration acknowledgement after a valid challenge", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "5".repeat(64);
  const identity = {
    schemaVersion: 1,
    service: "taskchef-dashboard",
    taskchefVersion: TASKCHEF_VERSION,
    serverVersion: DASHBOARD_SERVER_VERSION,
    workspace: canonicalWorkspace,
    launcher: "session",
  };
  const listener = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/api/health") {
      response.end(JSON.stringify(identity));
      return;
    }
    if (url.pathname === DASHBOARD_CONTROL_CHALLENGE_PATH) {
      const nonce = url.searchParams.get("nonce");
      response.end(JSON.stringify({
        schemaVersion: 1,
        nonce,
        proof: dashboardControlProof(secret, "challenge", nonce),
      }));
      return;
    }
    if (url.pathname === DASHBOARD_CONTROL_SESSION_PATH) {
      response.end(JSON.stringify({ schemaVersion: 1, accepted: true }));
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    ...identity,
    host: "127.0.0.1",
    port,
    secret,
  }));

  const harness = inProcessSessionHarness();
  const current = manager(workspace, port, harness);
  await assert.rejects(current.ensure(), /refused authenticated Codex-session registration/);
  assert.equal(listener.listening, true);
});

test("manager rejects an unsigned lease transfer after a valid older-session challenge", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "4".repeat(64);
  const identity = {
    schemaVersion: 1,
    service: "taskchef-dashboard",
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    workspace: canonicalWorkspace,
    launcher: "session",
  };
  const listener = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/api/health") response.end(JSON.stringify(identity));
    else if (url.pathname === DASHBOARD_CONTROL_CHALLENGE_PATH) {
      const nonce = url.searchParams.get("nonce");
      response.end(JSON.stringify({
        schemaVersion: 1,
        nonce,
        proof: dashboardControlProof(secret, "challenge", nonce),
      }));
    } else if (url.pathname === DASHBOARD_CONTROL_HANDOFF_PATH) {
      response.writeHead(202).end(JSON.stringify({
        schemaVersion: 1,
        accepted: true,
        pids: [process.pid],
      }));
    } else response.writeHead(404).end("{}");
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    ...identity,
    host: "127.0.0.1",
    port,
    secret,
  }));

  const harness = inProcessSessionHarness();
  const current = manager(workspace, port, harness);
  await assert.rejects(current.ensure(), /refused authenticated TaskChef session handoff/);
  assert.equal(harness.runtimes.length, 0);
  assert.equal(listener.listening, true);
});

test("atomic handoff fences registrations before transferring the final lease set", async (t) => {
  const workspace = await workspaceFixture();
  const secret = "7".repeat(64);
  let shutdownCount = 0;
  let enterHandoff;
  let releaseHandoff;
  const leases = new Set();
  const handoffEntered = new Promise((resolve) => { enterHandoff = resolve; });
  const handoffGate = new Promise((resolve) => { releaseHandoff = resolve; });
  const server = await createDashboardServer({
    workspace,
    port: 0,
    launcher: "session",
    control: {
      secret,
      onShutdown: async () => { shutdownCount += 1; },
      onSession: async () => {},
      onHandoff: async (pid) => {
        leases.add(pid);
        enterHandoff();
        await handoffGate;
        return [...leases];
      },
    },
  });
  t.after(() => server.close());

  const activatingPid = 501;
  const handoffNonce = createDashboardControlNonce();
  const handoff = fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: activatingPid,
      nonce: handoffNonce,
      proof: dashboardControlProof(secret, `handoff:${activatingPid}`, handoffNonce),
    }),
  });
  await handoffEntered;

  const joiningPid = 502;
  const sessionNonce = createDashboardControlNonce();
  const registration = await fetch(`${server.origin}${DASHBOARD_CONTROL_SESSION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: joiningPid,
      nonce: sessionNonce,
      proof: dashboardControlProof(secret, `session:${joiningPid}`, sessionNonce),
    }),
  });
  assert.equal(registration.status, 409);
  assert.equal((await registration.json()).reason, "retiring");

  releaseHandoff();
  const response = await handoff;
  assert.equal(response.status, 200);
  const prepared = await response.json();
  assert.deepEqual(prepared.pids, [activatingPid]);
  assert.equal(shutdownCount, 0);

  const commitNonce = createDashboardControlNonce();
  const commitRequest = fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: prepared.id,
      nonce: commitNonce,
      proof: dashboardControlProof(secret, `handoff-commit:${prepared.id}`, commitNonce),
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gracePid = 503;
  const graceNonce = createDashboardControlNonce();
  const graceJoin = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: gracePid,
      nonce: graceNonce,
      proof: dashboardControlProof(secret, `handoff:${gracePid}`, graceNonce),
    }),
  });
  assert.equal(graceJoin.status, 200);
  assert.deepEqual((await graceJoin.json()).pids, [activatingPid, gracePid]);
  const commit = await commitRequest;
  assert.equal(commit.status, 202);
  const committed = await commit.json();
  assert.deepEqual(committed.pids, [activatingPid, gracePid]);
  assert.equal(verifyDashboardControlProof(
    secret,
    `handoff-committed:${prepared.id}:${JSON.stringify(committed.pids)}`,
    commitNonce,
    committed.proof,
  ), true);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(shutdownCount, 1);
});

test("handoff joins are fenced while the final snapshot is being persisted", async (t) => {
  const workspace = await workspaceFixture();
  const secret = "0".repeat(64);
  const leases = new Set();
  let persistenceEntered;
  let releasePersistence;
  const entered = new Promise((resolve) => { persistenceEntered = resolve; });
  const gate = new Promise((resolve) => { releasePersistence = resolve; });
  const server = await createDashboardServer({
    workspace,
    port: 0,
    launcher: "session",
    control: {
      secret,
      onShutdown: async () => {},
      onSession: (pid) => { leases.add(pid); },
      onHandoff: (pid) => { leases.add(pid); return [...leases]; },
      onHandoffFinalized: async () => {
        persistenceEntered();
        await gate;
      },
    },
  });
  t.after(async () => { releasePersistence(); await server.close(); });

  const firstPid = 801;
  const prepareNonce = createDashboardControlNonce();
  const prepare = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: firstPid,
      nonce: prepareNonce,
      proof: dashboardControlProof(secret, `handoff:${firstPid}`, prepareNonce),
    }),
  });
  const prepared = await prepare.json();
  const commitNonce = createDashboardControlNonce();
  const commitRequest = fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: prepared.id,
      nonce: commitNonce,
      proof: dashboardControlProof(secret, `handoff-commit:${prepared.id}`, commitNonce),
    }),
  });
  await entered;

  const latePid = 802;
  const lateNonce = createDashboardControlNonce();
  const lateJoin = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: latePid,
      nonce: lateNonce,
      proof: dashboardControlProof(secret, `handoff:${latePid}`, lateNonce),
    }),
  });
  assert.equal(lateJoin.status, 409);
  assert.equal((await lateJoin.json()).reason, "retiring");
  releasePersistence();
  const commit = await commitRequest;
  assert.equal(commit.status, 202);
  assert.deepEqual((await commit.json()).pids, [firstPid]);
});

test("lost prepare response is idempotently recoverable before handoff commit", async (t) => {
  const workspace = await workspaceFixture();
  const secret = "2".repeat(64);
  let enterPrepare;
  let releasePrepare;
  let prepareCount = 0;
  let shutdownCount = 0;
  const entered = new Promise((resolve) => { enterPrepare = resolve; });
  const gate = new Promise((resolve) => { releasePrepare = resolve; });
  const server = await createDashboardServer({
    workspace,
    port: 0,
    launcher: "session",
    control: {
      secret,
      onShutdown: async () => { shutdownCount += 1; },
      onSession: async () => {},
      onHandoff: async (pid) => {
        prepareCount += 1;
        enterPrepare();
        await gate;
        return [pid];
      },
    },
  });
  t.after(() => server.close());

  const pid = 601;
  const firstNonce = createDashboardControlNonce();
  const controller = new AbortController();
  const first = fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid,
      nonce: firstNonce,
      proof: dashboardControlProof(secret, `handoff:${pid}`, firstNonce),
    }),
    signal: controller.signal,
  });
  await entered;
  controller.abort();
  await assert.rejects(first, /abort/i);
  releasePrepare();
  await new Promise((resolve) => setImmediate(resolve));

  const retryNonce = createDashboardControlNonce();
  const retry = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid,
      nonce: retryNonce,
      proof: dashboardControlProof(secret, `handoff:${pid}`, retryNonce),
    }),
  });
  assert.equal(retry.status, 200);
  const prepared = await retry.json();
  assert.deepEqual(prepared.pids, [pid]);
  assert.equal(prepareCount, 1);
  assert.equal(shutdownCount, 0);

  const commitNonce = createDashboardControlNonce();
  const commit = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: prepared.id,
      nonce: commitNonce,
      proof: dashboardControlProof(secret, `handoff-commit:${prepared.id}`, commitNonce),
    }),
  });
  assert.equal(commit.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(shutdownCount, 1);
});

test("failed final snapshot persistence reopens registration and handoff", async (t) => {
  const workspace = await workspaceFixture();
  const secret = "d".repeat(64);
  const leases = new Set();
  let finalizationAttempts = 0;
  const server = await createDashboardServer({
    workspace,
    port: 0,
    launcher: "session",
    control: {
      secret,
      onShutdown: async () => {},
      onSession: (pid) => { leases.add(pid); },
      onHandoff: (pid) => { leases.add(pid); return [...leases]; },
      onHandoffFinalized: async () => {
        finalizationAttempts += 1;
        throw new Error("injected persistence failure");
      },
    },
  });
  t.after(() => server.close());

  const pid = 701;
  const prepareNonce = createDashboardControlNonce();
  const prepare = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid,
      nonce: prepareNonce,
      proof: dashboardControlProof(secret, `handoff:${pid}`, prepareNonce),
    }),
  });
  const prepared = await prepare.json();
  const commitNonce = createDashboardControlNonce();
  const commit = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: prepared.id,
      nonce: commitNonce,
      proof: dashboardControlProof(secret, `handoff-commit:${prepared.id}`, commitNonce),
    }),
  });
  assert.equal(commit.status, 409);
  assert.equal(finalizationAttempts, 1);

  const registrationPid = 702;
  const registrationNonce = createDashboardControlNonce();
  const registration = await fetch(`${server.origin}${DASHBOARD_CONTROL_SESSION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: registrationPid,
      nonce: registrationNonce,
      proof: dashboardControlProof(secret, `session:${registrationPid}`, registrationNonce),
    }),
  });
  assert.equal(registration.status, 200);

  const retryPid = 703;
  const retryNonce = createDashboardControlNonce();
  const retry = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: retryPid,
      nonce: retryNonce,
      proof: dashboardControlProof(secret, `handoff:${retryPid}`, retryNonce),
    }),
  });
  assert.equal(retry.status, 200);
  assert.notEqual((await retry.json()).id, prepared.id);
});

test("atomic handoff refuses a distinct activating PID when the lease set is full", async (t) => {
  const workspace = await workspaceFixture();
  const secret = "8".repeat(64);
  let shutdownCount = 0;
  const lease = createDashboardSessionLease({
    initialPid: 100,
    checkIntervalMs: 60_000,
    isAlive: () => true,
    onExpire: async () => {},
  });
  for (let pid = 101; pid < 100 + MAX_DASHBOARD_SESSION_PIDS; pid += 1) {
    lease.register(pid);
  }
  const server = await createDashboardServer({
    workspace,
    port: 0,
    launcher: "session",
    control: {
      secret,
      onShutdown: async () => { shutdownCount += 1; },
      onSession: (pid) => lease.register(pid),
      onHandoff: (pid) => {
        lease.register(pid);
        return lease.snapshot();
      },
    },
  });
  t.after(async () => {
    lease.close();
    await server.close();
  });

  const activatingPid = 999;
  const nonce = createDashboardControlNonce();
  const response = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: activatingPid,
      nonce,
      proof: dashboardControlProof(secret, `handoff:${activatingPid}`, nonce),
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "refused");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownCount, 0);
  assert.equal((await readDashboardIdentity({ port: server.port })).launcher, "session");
});

test("handoff commit reserves capacity for one distinct recovery activator", async (t) => {
  const workspace = await workspaceFixture();
  const secret = "5".repeat(64);
  let shutdownCount = 0;
  const lease = createDashboardSessionLease({
    initialPid: 100,
    checkIntervalMs: 60_000,
    isAlive: () => true,
    onExpire: async () => {},
  });
  for (let pid = 101; pid < 100 + MAX_DASHBOARD_SESSION_PIDS; pid += 1) {
    lease.register(pid);
  }
  const server = await createDashboardServer({
    workspace,
    port: 0,
    launcher: "session",
    control: {
      secret,
      onShutdown: async () => { shutdownCount += 1; },
      onSession: (pid) => lease.register(pid),
      onHandoff: (pid) => { lease.register(pid); return lease.snapshot(); },
    },
  });
  t.after(async () => { lease.close(); await server.close(); });

  const prepareNonce = createDashboardControlNonce();
  const prepare = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pid: 100,
      nonce: prepareNonce,
      proof: dashboardControlProof(secret, "handoff:100", prepareNonce),
    }),
  });
  assert.equal(prepare.status, 200);
  const prepared = await prepare.json();
  assert.equal(prepared.pids.length, MAX_DASHBOARD_SESSION_PIDS);
  const commitNonce = createDashboardControlNonce();
  const commit = await fetch(`${server.origin}${DASHBOARD_CONTROL_HANDOFF_COMMIT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: prepared.id,
      nonce: commitNonce,
      proof: dashboardControlProof(secret, `handoff-commit:${prepared.id}`, commitNonce),
    }),
  });
  assert.equal(commit.status, 409);
  assert.equal(shutdownCount, 0);
  assert.equal((await readDashboardIdentity({ port: server.port })).launcher, "session");
});

test("session startup rejects a transferred lease union above the bound", async () => {
  const workspace = await workspaceFixture();
  const transferred = Array.from({ length: MAX_DASHBOARD_SESSION_PIDS }, (_, index) => index + 100);
  await assert.rejects(
    runDashboardSessionProcess({
      workspace,
      port: 0,
      secret: "6".repeat(64),
      sessionPid: 999,
      sessionPids: transferred,
      processObject: new EventEmitter(),
    }),
    /transferred session PIDs are invalid/,
  );
});

test("manager leaves standalone, different-workspace, unknown, and legacy listeners untouched", async (t) => {
  const workspace = await workspaceFixture("one");
  const otherWorkspace = await workspaceFixture("two");
  for (const kind of ["standalone", "different-workspace", "unknown", "legacy"]) {
    await t.test(kind, async () => {
    const port = await unusedPort();
    let listener;
    if (kind === "unknown") {
      listener = http.createServer((_request, response) => {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end("{}");
      });
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, "127.0.0.1", resolve);
      });
    } else {
      listener = await createDashboardServer({
        workspace: kind === "different-workspace" ? otherWorkspace : workspace,
        port,
        launcher: kind === "legacy" ? "mcp" : "standalone",
        taskchefVersion: kind === "legacy" ? "7.22.0" : undefined,
      });
    }
    const harness = inProcessSessionHarness();
    const current = manager(workspace, port, harness, { taskchefVersion: "7.23.0" });
    await assert.rejects(current.ensure(), /port conflict|unknown, stale|verified older/);
    assert.equal(listener.listening ?? listener.monitor.closed === undefined, true);
    await current.close();
    await harness.close();
    if (kind === "unknown") await new Promise((resolve) => listener.close(resolve));
    else await listener.close();
    });
  }
});

test("manager never shuts down a spoofed older TaskChef identity", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "e".repeat(64);
  let shutdownRequests = 0;
  const identity = {
    schemaVersion: 1,
    service: "taskchef-dashboard",
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    workspace: canonicalWorkspace,
    launcher: "mcp",
  };
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    ...identity, host: "127.0.0.1", port, secret,
  }));
  const listener = http.createServer((request, response) => {
    if (request.url === "/api/health") response.end(JSON.stringify(identity));
    else if (request.url?.startsWith(DASHBOARD_CONTROL_CHALLENGE_PATH)) {
      response.end(JSON.stringify({ schemaVersion: 1, nonce: "wrong", proof: "f".repeat(64) }));
    } else {
      if (request.url === DASHBOARD_CONTROL_SHUTDOWN_PATH) shutdownRequests += 1;
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const harness = inProcessSessionHarness();
  const current = manager(workspace, port, harness, { taskchefVersion: "7.23.0" });
  await assert.rejects(current.ensure(), /did not prove control/);
  assert.equal(shutdownRequests, 0);
  assert.equal(listener.listening, true);
});

test("owner authentication uses a wall-clock deadline when challenge responses hang", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "9".repeat(64);
  const identity = {
    schemaVersion: 1,
    service: "taskchef-dashboard",
    taskchefVersion: TASKCHEF_VERSION,
    serverVersion: DASHBOARD_SERVER_VERSION,
    workspace: canonicalWorkspace,
    launcher: "session",
  };
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    ...identity, host: "127.0.0.1", port, secret,
  }));
  const listener = http.createServer((request, response) => {
    if (request.url === "/api/health") response.end(JSON.stringify(identity));
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const current = manager(workspace, port, harness, { ownerAuthTimeoutMs: 100 });
  const startedAt = Date.now();
  await assert.rejects(current.ensure(), /did not prove control/);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(harness.runtimes.length, 0);
});

test("listener loss between health and challenge converges on a replacement", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "4".repeat(64);
  const identity = {
    schemaVersion: 1,
    service: "taskchef-dashboard",
    taskchefVersion: TASKCHEF_VERSION,
    serverVersion: DASHBOARD_SERVER_VERSION,
    workspace: canonicalWorkspace,
    launcher: "session",
  };
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    ...identity, host: "127.0.0.1", port, secret,
  }));
  let closeListener;
  const listenerClosed = new Promise((resolve) => { closeListener = resolve; });
  const listener = http.createServer((request, response) => {
    if (request.url === "/api/health") {
      response.setHeader("Connection", "close");
      response.end(JSON.stringify(identity));
      listener.close(closeListener);
    }
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", resolve);
  });
  t.after(async () => {
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
  });
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const current = manager(workspace, port, harness, { ownerAuthTimeoutMs: 500 });
  const result = await current.ensure();
  await listenerClosed;
  assert.equal(result.action, "started");
  assert.equal(harness.runtimes.length, 1);
});

test("owner authentication deadline also bounds a hung private metadata read", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const identity = {
    schemaVersion: 1,
    service: "taskchef-dashboard",
    taskchefVersion: TASKCHEF_VERSION,
    serverVersion: DASHBOARD_SERVER_VERSION,
    workspace: canonicalWorkspace,
    launcher: "session",
  };
  const listener = http.createServer((request, response) => {
    if (request.url === "/api/health") response.end(JSON.stringify(identity));
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const current = manager(workspace, port, harness, {
    ownerAuthTimeoutMs: 100,
    readOwner: () => new Promise(() => {}),
  });
  const startedAt = Date.now();
  await assert.rejects(current.ensure(), /without usable authenticated ownership metadata/);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(harness.runtimes.length, 0);
});

test("lost final commit responses recover the signed durable lease snapshot", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "a".repeat(64);
  const id = createDashboardControlNonce();
  const pids = [process.pid, process.ppid];
  const owner = dashboardOwnerMetadata({
    workspace: canonicalWorkspace,
    host: "127.0.0.1",
    port,
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    launcher: "session",
    secret,
  });
  await writeDashboardOwner(canonicalWorkspace, owner);
  await writeDashboardHandoff(canonicalWorkspace, dashboardHandoffMetadata({
    ...owner,
    id,
    pids,
    secret,
  }));
  assert.equal((await lstat(path.join(workspace, DASHBOARD_HANDOFF_FILE))).mode & 0o777, 0o600);

  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const current = manager(workspace, port, harness, { taskchefVersion: "7.23.0" });
  assert.equal((await current.ensure()).action, "started");
  assert.deepEqual(new Set(harness.runtimes.at(-1).lease.snapshot()), new Set(pids));
  assert.equal((await readDashboardHandoff(canonicalWorkspace)).id, id);
});

test("a forged durable handoff snapshot cannot inject session leases", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const owner = dashboardOwnerMetadata({
    workspace: canonicalWorkspace,
    host: "127.0.0.1",
    port,
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    launcher: "session",
    secret: "b".repeat(64),
  });
  await writeDashboardOwner(canonicalWorkspace, owner);
  await writeDashboardHandoff(canonicalWorkspace, dashboardHandoffMetadata({
    ...owner,
    id: createDashboardControlNonce(),
    pids: [process.pid, process.ppid],
    secret: "c".repeat(64),
  }));

  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const current = manager(workspace, port, harness, {
    taskchefVersion: "7.23.0",
    ownerAuthTimeoutMs: 100,
  });
  assert.equal((await current.ensure()).action, "started");
  assert.deepEqual(harness.runtimes.at(-1).lease.snapshot(), [process.pid]);
});

test("retained newer ownership blocks an older relaunch with no listener", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    workspace: canonicalWorkspace,
    host: "127.0.0.1",
    port,
    taskchefVersion: "7.24.0",
    serverVersion: DASHBOARD_SERVER_VERSION,
    launcher: "session",
    secret: "e".repeat(64),
  }));
  let launches = 0;
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const older = manager(workspace, port, harness, {
    taskchefVersion: "7.23.0",
    launchSession: async (options) => {
      launches += 1;
      return harness.launchSession(options);
    },
  });
  await assert.rejects(older.ensure(), /newer TaskChef 7\.24\.0|refusing to downgrade/);
  assert.equal(launches, 0);
});

test("concurrent current-version activation elects one authenticated session server", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const first = manager(workspace, port, harness);
  const second = manager(workspace, port, harness);
  const results = await Promise.all([first.ensure(), second.ensure()]);
  assert.deepEqual(results.map((result) => result.action).sort(), ["reused", "started"]);
  assert.equal(harness.runtimes.length, 1);
});

test("exact-current activation waits through slow owner publication after health becomes visible", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    workspace: canonicalWorkspace,
    host: "127.0.0.1",
    port,
    taskchefVersion: TASKCHEF_VERSION,
    serverVersion: DASHBOARD_SERVER_VERSION,
    launcher: "session",
    secret: "3".repeat(64),
  }));
  let releaseOwner;
  let ownerWaiting;
  let serverVisible;
  const ownerGate = new Promise((resolve) => { releaseOwner = resolve; });
  const waiting = new Promise((resolve) => { ownerWaiting = resolve; });
  const visible = new Promise((resolve) => { serverVisible = resolve; });
  let runtimePromise;
  let runtime;
  const launchSession = async (options) => {
    runtimePromise = runDashboardSessionProcess({
      ...options,
      createServer: async (serverOptions) => {
        const server = await createDashboardServer(serverOptions);
        serverVisible();
        return server;
      },
      writeOwner: async (...args) => {
        ownerWaiting();
        await ownerGate;
        return writeDashboardOwner(...args);
      },
      processObject: new EventEmitter(),
    }).then((value) => { runtime = value; return value; });
    await visible;
    return { pid: process.pid };
  };
  t.after(async () => {
    releaseOwner();
    await runtimePromise?.catch(() => {});
    await runtime?.close();
  });
  const first = createDashboardManager({ workspace, port, sessionPid: process.pid, launchSession });
  const second = createDashboardManager({ workspace, port, sessionPid: process.pid, launchSession });
  const firstEnsure = first.ensure();
  await waiting;
  const secondEnsure = second.ensure();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  releaseOwner();
  const results = await Promise.all([firstEnsure, secondEnsure]);
  assert.deepEqual(results.map((result) => result.action).sort(), ["reused", "started"]);
});

test("upgrade activation waits through slow prior-version owner publication", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  let releaseOwner;
  let ownerWaiting;
  let serverVisible;
  const ownerGate = new Promise((resolve) => { releaseOwner = resolve; });
  const waiting = new Promise((resolve) => { ownerWaiting = resolve; });
  const visible = new Promise((resolve) => { serverVisible = resolve; });
  let priorRuntimePromise;
  let priorRuntime;
  const launchPriorSession = async (options) => {
    priorRuntimePromise = runDashboardSessionProcess({
      ...options,
      createServer: async (serverOptions) => {
        const server = await createDashboardServer(serverOptions);
        serverVisible();
        return server;
      },
      writeOwner: async (...args) => {
        ownerWaiting();
        await ownerGate;
        return writeDashboardOwner(...args);
      },
      processObject: new EventEmitter(),
    }).then((value) => { priorRuntime = value; return value; });
    await visible;
    return { pid: process.pid };
  };
  const replacementHarness = inProcessSessionHarness();
  t.after(async () => {
    releaseOwner();
    await priorRuntimePromise?.catch(() => {});
    await Promise.allSettled([priorRuntime?.close(), replacementHarness.close()]);
  });
  const prior = createDashboardManager({
    workspace,
    port,
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    sessionPid: process.pid,
    launchSession: launchPriorSession,
  });
  const current = manager(workspace, port, replacementHarness, {
    taskchefVersion: "7.23.0",
  });
  const priorEnsure = prior.ensure();
  void priorEnsure.catch(() => {});
  await waiting;
  const currentEnsure = current.ensure();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  releaseOwner();
  assert.equal((await currentEnsure).action, "started");
  await Promise.allSettled([priorEnsure]);
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.23.0");
});

test("exact-current activation replaces a session already committed to expiry", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "6".repeat(64);
  let expiring;
  let closeScheduled = false;
  expiring = await createDashboardServer({
    workspace,
    port,
    launcher: "session",
    control: {
      secret,
      onShutdown: () => expiring.close(),
      onSession: () => {
        if (!closeScheduled) {
          closeScheduled = true;
          setTimeout(() => { void expiring.close(); }, 25);
        }
        throw Object.assign(new Error("dashboard session is expiring"), {
          code: "TASKCHEF_DASHBOARD_SESSION_RETIRING",
        });
      },
      onHandoff: (pid) => [pid],
    },
  });
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    workspace: canonicalWorkspace,
    host: "127.0.0.1",
    port,
    taskchefVersion: expiring.identity.taskchefVersion,
    serverVersion: expiring.identity.serverVersion,
    launcher: "session",
    secret,
  }));
  const harness = inProcessSessionHarness();
  t.after(() => Promise.allSettled([expiring.close(), harness.close()]));

  const current = manager(workspace, port, harness);
  assert.equal((await current.ensure()).action, "started");
  assert.equal(harness.runtimes.length, 1);
  assert.equal((await readDashboardIdentity({ port })).launcher, "session");
});

test("concurrent upgrade activation elects one current-version replacement", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const oldManager = manager(workspace, port, harness, {
    taskchefVersion: "7.22.1",
    serverVersion: "3",
  });
  await oldManager.ensure();
  const first = manager(workspace, port, harness, { taskchefVersion: "7.23.0" });
  const second = manager(workspace, port, harness, { taskchefVersion: "7.23.0" });
  const results = await Promise.all([first.ensure(), second.ensure()]);
  assert.deepEqual(results.map((result) => result.action).sort(), ["reused", "started"]);
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.23.0");
});

test("concurrent distinct upgrades converge on the highest TaskChef version", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const oldManager = manager(workspace, port, harness, {
    taskchefVersion: "7.22.1",
    serverVersion: "3",
  });
  await oldManager.ensure();
  const lower = manager(workspace, port, harness, { taskchefVersion: "7.23.0" });
  const higher = manager(workspace, port, harness, {
    taskchefVersion: "7.24.0",
    launchSession: async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return harness.launchSession(options);
    },
  });
  const outcomes = await Promise.allSettled([lower.ensure(), higher.ensure()]);
  assert.equal(outcomes.every((outcome) => outcome.status === "fulfilled"), true);
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.24.0");
});

test("late concurrent upgrader recovers final leases across the old-to-new listener gap", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const oldManager = manager(workspace, port, harness, {
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    sessionPid: process.pid,
  });
  const otherOldSession = manager(workspace, port, harness, {
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    sessionPid: process.ppid,
  });
  await oldManager.ensure();
  await otherOldSession.ensure();

  let releaseElectedLaunch;
  let electedLaunchEntered;
  const electedGate = new Promise((resolve) => { releaseElectedLaunch = resolve; });
  const launchEntered = new Promise((resolve) => { electedLaunchEntered = resolve; });
  let currentLaunches = 0;
  const elected = manager(workspace, port, harness, {
    taskchefVersion: "7.23.0",
    launchSession: async (options) => {
      currentLaunches += 1;
      electedLaunchEntered();
      await electedGate;
      return harness.launchSession(options);
    },
  });
  const electedEnsure = elected.ensure();
  await launchEntered;
  await assert.rejects(readDashboardIdentity({ port }), /ECONNREFUSED|ECONNRESET/);

  const late = manager(workspace, port, harness, {
    taskchefVersion: "7.23.0",
    launchSession: async (options) => {
      currentLaunches += 1;
      return harness.launchSession(options);
    },
  });
  const lateEnsure = late.ensure();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(currentLaunches, 2);
  releaseElectedLaunch();
  const results = await Promise.all([electedEnsure, lateEnsure]);
  assert.deepEqual(results.map((result) => result.action).sort(), ["reused", "started"]);
  assert.deepEqual(
    new Set(harness.runtimes.at(-1).lease.snapshot()),
    new Set([process.pid, process.ppid]),
  );
});

test("late old-version activator cannot downgrade across the handoff gap", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const oldManager = manager(workspace, port, harness, {
    taskchefVersion: "7.22.1",
    serverVersion: "3",
  });
  await oldManager.ensure();

  let releaseElectedLaunch;
  let electedLaunchEntered;
  const electedGate = new Promise((resolve) => { releaseElectedLaunch = resolve; });
  const launchEntered = new Promise((resolve) => { electedLaunchEntered = resolve; });
  const elected = manager(workspace, port, harness, {
    taskchefVersion: "7.23.0",
    launchSession: async (options) => {
      electedLaunchEntered();
      await electedGate;
      return harness.launchSession(options);
    },
  });
  const electedEnsure = elected.ensure();
  await launchEntered;
  await assert.rejects(readDashboardIdentity({ port }), /ECONNREFUSED|ECONNRESET/);

  let oldLaunches = 0;
  const lateOld = manager(workspace, port, harness, {
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    ownerAuthTimeoutMs: 100,
    launchSession: async (options) => {
      oldLaunches += 1;
      return harness.launchSession(options);
    },
  });
  const lateEnsure = lateOld.ensure();
  await assert.rejects(lateEnsure, /already finalized retirement|refusing to relaunch/);
  assert.equal(oldLaunches, 0);
  releaseElectedLaunch();
  assert.equal((await electedEnsure).action, "started");
  assert.equal(oldLaunches, 0);
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.23.0");
});

test("concurrent upgrade waits through a delayed elected replacement startup", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const oldManager = manager(workspace, port, harness, {
    taskchefVersion: "7.22.1",
    serverVersion: "3",
  });
  await oldManager.ensure();

  let currentLaunches = 0;
  const delayedLaunch = async (options) => {
    currentLaunches += 1;
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    return harness.launchSession(options);
  };
  const first = manager(workspace, port, harness, {
    taskchefVersion: "7.23.0",
    launchSession: delayedLaunch,
  });
  const second = manager(workspace, port, harness, {
    taskchefVersion: "7.23.0",
    launchSession: delayedLaunch,
  });
  const results = await Promise.all([first.ensure(), second.ensure()]);
  assert.deepEqual(results.map((result) => result.action).sort(), ["reused", "started"]);
  assert.ok(currentLaunches >= 1 && currentLaunches <= 2);
  assert.equal(harness.runtimes.length, 2);
});

test("concurrent upgrade recovers after the elected activator dies post-commit", async (t) => {
  const workspace = await workspaceFixture();
  const canonicalWorkspace = await realpath(workspace);
  const port = await unusedPort();
  const secret = "0".repeat(64);
  let enterPrepare;
  let releasePrepare;
  const prepareEntered = new Promise((resolve) => { enterPrepare = resolve; });
  const prepareGate = new Promise((resolve) => { releasePrepare = resolve; });
  const transferredPids = new Set([process.ppid]);
  let oldServer;
  oldServer = await createDashboardServer({
    workspace,
    port,
    launcher: "session",
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    control: {
      secret,
      onShutdown: () => oldServer.close(),
      onSession: async () => {},
      onHandoff: async (pid) => {
        enterPrepare();
        await prepareGate;
        transferredPids.add(pid);
        return [...transferredPids];
      },
    },
  });
  await writeDashboardOwner(canonicalWorkspace, dashboardOwnerMetadata({
    workspace: canonicalWorkspace,
    host: "127.0.0.1",
    port,
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    launcher: "session",
    secret,
  }));
  const harness = inProcessSessionHarness();
  t.after(() => Promise.allSettled([oldServer.close(), harness.close()]));
  const elected = manager(workspace, port, harness, {
    taskchefVersion: "7.23.0",
    launchSession: async () => { throw new Error("elected activator exited"); },
  });
  const recovering = manager(workspace, port, harness, {
    taskchefVersion: "7.23.0",
    handoffConvergenceAttempts: 5,
  });

  const electedResult = elected.ensure();
  void electedResult.catch(() => {});
  await prepareEntered;
  const recoveringResult = recovering.ensure();
  releasePrepare();
  await assert.rejects(electedResult, /elected activator exited/);
  assert.equal((await recoveringResult).action, "started");
  assert.equal((await readDashboardIdentity({ port })).taskchefVersion, "7.23.0");
  assert.deepEqual(
    new Set(harness.runtimes.at(-1).lease.snapshot()),
    new Set([process.pid, process.ppid]),
  );
});

test("version handoff transfers every live authenticated Codex-session lease", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const oldManager = manager(workspace, port, harness, {
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    sessionPid: process.pid,
  });
  const otherSession = manager(workspace, port, harness, {
    taskchefVersion: "7.22.1",
    serverVersion: "3",
    sessionPid: process.ppid,
  });
  await oldManager.ensure();
  await otherSession.ensure();
  const current = manager(workspace, port, harness, { taskchefVersion: "7.23.0" });
  await current.ensure();
  assert.deepEqual(
    new Set(harness.runtimes.at(-1).lease.snapshot()),
    new Set([process.pid, process.ppid]),
  );
});

test("session reuse rejects ownership metadata that is no longer private", async (t) => {
  const workspace = await workspaceFixture();
  const port = await unusedPort();
  const harness = inProcessSessionHarness();
  t.after(() => harness.close());
  const first = manager(workspace, port, harness);
  await first.ensure();
  const ownerPath = path.join(workspace, DASHBOARD_OWNER_FILE);
  await chmod(ownerPath, 0o644);
  await assert.rejects(readDashboardOwner(await realpath(workspace)), /private regular file/);
  const peer = manager(workspace, port, harness);
  await assert.rejects(peer.ensure(), /without usable authenticated ownership metadata/);
  assert.equal((await readDashboardIdentity({ port })).launcher, "session");
});

test("session runtime closes its listener even when lease cleanup fails", async () => {
  const workspace = await workspaceFixture();
  const runtime = await runDashboardSessionProcess({
    workspace,
    port: 0,
    secret: "1".repeat(64),
    sessionPid: process.pid,
    createLease: () => ({ register() {}, close() { throw new Error("cleanup failed"); } }),
    processObject: new EventEmitter(),
  });
  const port = runtime.server.port;
  await assert.rejects(runtime.close(), /cleanup failed/);
  await assert.rejects(readDashboardIdentity({ port }), /ECONNREFUSED|ECONNRESET/);
});

test("startup cancellation closes a listener while owner publication is blocked", async (t) => {
  const workspace = await workspaceFixture();
  const controller = new AbortController();
  let boundPort;
  let ownerStarted;
  let releaseOwner;
  const ownerWaiting = new Promise((resolve) => { ownerStarted = resolve; });
  const ownerGate = new Promise((resolve) => { releaseOwner = resolve; });
  let successor = null;
  t.after(async () => {
    releaseOwner();
    await successor?.close();
  });
  const starting = runDashboardSessionProcess({
    workspace,
    port: 0,
    secret: "1".repeat(64),
    sessionPid: process.pid,
    signal: controller.signal,
    createServer: async (options) => {
      const server = await createDashboardServer(options);
      boundPort = server.port;
      return server;
    },
    writeOwner: async () => {
      ownerStarted();
      await ownerGate;
    },
    processObject: new EventEmitter(),
  });
  void starting.catch(() => {});
  await ownerWaiting;
  assert.equal((await readDashboardIdentity({ port: boundPort })).launcher, "session");
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await readDashboardIdentity({ port: boundPort })).launcher, "session");
  await assert.rejects(
    createDashboardServer({ workspace, port: boundPort, launcher: "session" }),
    (error) => error?.code === "EADDRINUSE",
  );
  releaseOwner();
  await assert.rejects(
    starting,
    (error) => error?.code === "TASKCHEF_DASHBOARD_START_TIMEOUT",
  );
  await assert.rejects(
    readDashboardIdentity({ port: boundPort }),
    /ECONNREFUSED|ECONNRESET|socket hang up/,
  );
  successor = await runDashboardSessionProcess({
    workspace,
    port: boundPort,
    secret: "2".repeat(64),
    sessionPid: process.pid,
    processObject: new EventEmitter(),
  });
  assert.equal((await readDashboardOwner(await realpath(workspace))).secret, "2".repeat(64));
});

test("lease expiry keeps the listener fenced until owner publication settles", async (t) => {
  const workspace = await workspaceFixture();
  let boundPort;
  let ownerStarted;
  let releaseOwner;
  let expire;
  let successor = null;
  const ownerWaiting = new Promise((resolve) => { ownerStarted = resolve; });
  const ownerGate = new Promise((resolve) => { releaseOwner = resolve; });
  t.after(async () => {
    releaseOwner();
    await successor?.close();
  });
  const starting = runDashboardSessionProcess({
    workspace,
    port: 0,
    secret: "1".repeat(64),
    sessionPid: process.pid,
    createServer: async (options) => {
      const server = await createDashboardServer(options);
      boundPort = server.port;
      return server;
    },
    createLease: ({ onExpire }) => {
      expire = onExpire;
      return { register() {}, snapshot: () => [process.pid], close() {} };
    },
    writeOwner: async () => {
      ownerStarted();
      await ownerGate;
    },
    processObject: new EventEmitter(),
  });
  void starting.catch(() => {});
  await ownerWaiting;
  void expire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await readDashboardIdentity({ port: boundPort })).launcher, "session");
  await assert.rejects(
    createDashboardServer({ workspace, port: boundPort, launcher: "session" }),
    (error) => error?.code === "EADDRINUSE",
  );
  releaseOwner();
  await assert.rejects(
    starting,
    (error) => error?.code === "TASKCHEF_DASHBOARD_START_EXIT",
  );
  successor = await runDashboardSessionProcess({
    workspace,
    port: boundPort,
    secret: "2".repeat(64),
    sessionPid: process.pid,
    processObject: new EventEmitter(),
  });
  assert.equal((await readDashboardOwner(await realpath(workspace))).secret, "2".repeat(64));
});

test("SIGTERM keeps the listener fenced until owner publication settles", async (t) => {
  const workspace = await workspaceFixture();
  const processObject = new EventEmitter();
  let boundPort;
  let ownerStarted;
  let releaseOwner;
  let successor = null;
  const ownerWaiting = new Promise((resolve) => { ownerStarted = resolve; });
  const ownerGate = new Promise((resolve) => { releaseOwner = resolve; });
  t.after(async () => {
    releaseOwner();
    await successor?.close();
  });
  const starting = runDashboardSessionProcess({
    workspace,
    port: 0,
    secret: "1".repeat(64),
    sessionPid: process.pid,
    createServer: async (options) => {
      const server = await createDashboardServer(options);
      boundPort = server.port;
      return server;
    },
    writeOwner: async () => {
      ownerStarted();
      await ownerGate;
    },
    processObject,
  });
  void starting.catch(() => {});
  await ownerWaiting;
  processObject.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await readDashboardIdentity({ port: boundPort })).launcher, "session");
  await assert.rejects(
    createDashboardServer({ workspace, port: boundPort, launcher: "session" }),
    (error) => error?.code === "EADDRINUSE",
  );
  releaseOwner();
  await assert.rejects(
    starting,
    (error) => error?.code === "TASKCHEF_DASHBOARD_START_EXIT",
  );
  successor = await runDashboardSessionProcess({
    workspace,
    port: boundPort,
    secret: "2".repeat(64),
    sessionPid: process.pid,
    processObject: new EventEmitter(),
  });
  assert.equal((await readDashboardOwner(await realpath(workspace))).secret, "2".repeat(64));
});

test("startup cancellation closes a listener returned after createServer was blocked", async (t) => {
  const workspace = await workspaceFixture();
  const controller = new AbortController();
  let boundPort;
  let serverBound;
  let releaseServer;
  const bound = new Promise((resolve) => { serverBound = resolve; });
  const serverGate = new Promise((resolve) => { releaseServer = resolve; });
  t.after(() => releaseServer());
  const starting = runDashboardSessionProcess({
    workspace,
    port: 0,
    secret: "1".repeat(64),
    sessionPid: process.pid,
    signal: controller.signal,
    createServer: async (options) => {
      const server = await createDashboardServer(options);
      boundPort = server.port;
      serverBound();
      await serverGate;
      return server;
    },
    processObject: new EventEmitter(),
  });
  void starting.catch(() => {});
  await bound;
  controller.abort();
  releaseServer();
  await assert.rejects(
    starting,
    (error) => error?.code === "TASKCHEF_DASHBOARD_START_TIMEOUT",
  );
  await assert.rejects(
    readDashboardIdentity({ port: boundPort }),
    /ECONNREFUSED|ECONNRESET|socket hang up/,
  );
});
