#!/usr/bin/env node

import { runDashboardSessionProcess } from "../src/dashboard-session-process.js";

let cancelled = false;
let runtime = null;
let readySent = false;
const startupController = new AbortController();
process.on("message", (message) => {
  if (message?.type !== "cancel") return;
  cancelled = true;
  startupController.abort();
  if (runtime) void runtime.close().finally(() => { process.exitCode = 1; });
});
process.on("disconnect", () => {
  if (readySent) return;
  cancelled = true;
  startupController.abort();
  if (runtime) void runtime.close().finally(() => { process.exitCode = 1; });
});

try {
  runtime = await runDashboardSessionProcess({ signal: startupController.signal });
  if (cancelled) {
    await runtime.close();
    throw Object.assign(new Error("dashboard session startup was cancelled"), {
      code: "TASKCHEF_DASHBOARD_START_TIMEOUT",
    });
  }
  if (process.send && process.connected) {
    readySent = true;
    await new Promise((resolve, reject) => {
      process.send({ type: "ready", port: runtime.server.port }, (error) =>
        error ? reject(error) : resolve());
    });
    if (process.connected) process.disconnect();
  }
} catch (error) {
  readySent = false;
  if (runtime) await runtime.close().catch(() => {});
  if (process.send && process.connected) {
    await new Promise((resolve) => {
      process.send({
        type: "error",
        code: typeof error?.code === "string" ? error.code : "TASKCHEF_DASHBOARD_START_FAILED",
      }, () => resolve());
    }).catch(() => {});
    if (process.connected) process.disconnect();
  }
  process.exitCode = 1;
}
