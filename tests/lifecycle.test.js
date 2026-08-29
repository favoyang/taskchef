import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { readDashboardIdentity } from "../src/dashboard-manager.js";
import { initializeWorkspace } from "../src/workspace.js";

const CHILD_PATH = fileURLToPath(new URL("./fixtures/mcp-lifecycle-child.js", import.meta.url));
const PARENT_PATH = fileURLToPath(new URL("./fixtures/mcp-lifecycle-parent.js", import.meta.url));

async function unusedPort() {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function processFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-mcp-lifecycle-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  const port = await unusedPort();
  return {
    workspace,
    port,
    env: {
      ...process.env,
      TASKCHEF_WORKSPACE: workspace,
      TASKCHEF_TEST_DASHBOARD_PORT: String(port),
    },
  };
}

async function waitForDashboard(port, expected = true, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readDashboardIdentity({ port, timeoutMs: 100 });
      if (expected) return;
    } catch (error) {
      if (!expected && ["ECONNREFUSED", "ECONNRESET"].includes(error?.code)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`dashboard did not become ${expected ? "available" : "unavailable"}`);
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const deadline = setTimeout(() => reject(new Error("child process did not exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal });
    });
  });
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await waitForExit(child).catch(() => {});
}

test("stdio MCP client close and stdin EOF release the owned dashboard", async (t) => {
  const clientFixture = await processFixture();
  const client = new Client({ name: "taskchef-lifecycle-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CHILD_PATH],
    env: clientFixture.env,
  });
  await client.connect(transport);
  await waitForDashboard(clientFixture.port);
  await client.close();
  await waitForDashboard(clientFixture.port, false);

  const eofFixture = await processFixture();
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: eofFixture.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => stopChild(child));
  await waitForDashboard(eofFixture.port);
  child.stdin.end();
  const exited = await waitForExit(child);
  assert.equal(exited.code, 0);
  await waitForDashboard(eofFixture.port, false);
});

test("SIGTERM and SIGINT gracefully close the MCP-owned dashboard", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const fixture = await processFixture();
    const child = spawn(process.execPath, [CHILD_PATH], {
      env: fixture.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => stopChild(child));
    await waitForDashboard(fixture.port);
    assert.equal(child.kill(signal), true);
    const exited = await waitForExit(child).catch((error) => {
      throw new Error(`${signal} shutdown failed: ${error.message}`);
    });
    assert.equal(exited.code, 0);
    await waitForDashboard(fixture.port, false);
  }
});

test("transport-driven protocol close exits with stdin still open", async (t) => {
  const fixture = await processFixture();
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: { ...fixture.env, TASKCHEF_TEST_TRANSPORT_CLOSE_MS: "250" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => stopChild(child));
  await waitForDashboard(fixture.port);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal((await waitForExit(child)).code, 0);
  await waitForDashboard(fixture.port, false);
});

test("SIGTERM during MCP connection startup cannot attach a transport after shutdown", async (t) => {
  const fixture = await processFixture();
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: { ...fixture.env, TASKCHEF_TEST_CONNECT_DELAY_MS: "500" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => stopChild(child));
  await waitForDashboard(fixture.port);
  assert.equal(child.kill("SIGTERM"), true);
  assert.equal((await waitForExit(child)).code, 0);
  await waitForDashboard(fixture.port, false);
});

test("SIGTERM bounds shutdown when MCP transport startup never settles", async (t) => {
  const fixture = await processFixture();
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: { ...fixture.env, TASKCHEF_TEST_CONNECT_NEVER: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => stopChild(child));
  await waitForDashboard(fixture.port);
  const startedAt = Date.now();
  assert.equal(child.kill("SIGTERM"), true);
  assert.equal((await waitForExit(child)).code, 0);
  assert.equal(Date.now() - startedAt < 4_000, true);
  await waitForDashboard(fixture.port, false);
});

test("SIGTERM still closes the MCP transport when dashboard cleanup reports failure", async (t) => {
  const fixture = await processFixture();
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: { ...fixture.env, TASKCHEF_TEST_DASHBOARD_CLOSE_FAIL: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => stopChild(child));
  await waitForDashboard(fixture.port);
  assert.equal(child.kill("SIGTERM"), true);
  const exited = await waitForExit(child);
  assert.equal(exited.code, 1);
  await waitForDashboard(fixture.port, false);
});

test("abrupt parent exit is detected even while the inherited MCP stdin remains open", async (t) => {
  const fixture = await processFixture();
  const parent = spawn(process.execPath, [PARENT_PATH], {
    env: fixture.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let childPid = null;
  t.after(async () => {
    await stopChild(parent);
    if (childPid) {
      try { process.kill(childPid, "SIGTERM"); } catch {}
    }
  });
  const line = await new Promise((resolve, reject) => {
    let output = "";
    parent.stdout.setEncoding("utf8");
    parent.stdout.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve(output.slice(0, newline));
    });
    parent.once("error", reject);
  });
  childPid = JSON.parse(line).childPid;
  assert.equal(Number.isInteger(childPid), true);
  await waitForDashboard(fixture.port);
  assert.equal(parent.kill("SIGUSR1"), true);
  assert.equal((await waitForExit(parent)).code, 0);
  await waitForDashboard(fixture.port, false, 6_000);
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try { process.kill(childPid, 0); } catch (error) {
      if (error?.code === "ESRCH") return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("orphaned MCP process remained after parent loss");
});
