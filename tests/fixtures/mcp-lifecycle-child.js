import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createDashboardManager } from "../../src/dashboard-manager.js";
import { createTaskChefMcpServer } from "../../src/mcp.js";
import { runTaskChefMcpProcess } from "../../src/mcp-process.js";

const workspace = process.env.TASKCHEF_WORKSPACE;
const port = Number(process.env.TASKCHEF_TEST_DASHBOARD_PORT);
const sessionPid = Number(process.env.TASKCHEF_TEST_SESSION_PID ?? process.ppid);
const dashboardManager = createDashboardManager({ workspace, port, sessionPid });
if (process.env.TASKCHEF_TEST_DASHBOARD_CLOSE_FAIL === "1") {
  const close = dashboardManager.close.bind(dashboardManager);
  dashboardManager.close = async () => {
    await close();
    throw new Error("injected dashboard cleanup failure");
  };
}
const server = createTaskChefMcpServer({ workspace, dashboardManager });
const transport = new StdioServerTransport();
const connectDelayMs = Number(process.env.TASKCHEF_TEST_CONNECT_DELAY_MS ?? 0);
if (process.env.TASKCHEF_TEST_CONNECT_NEVER === "1") {
  transport.start = async () => new Promise(() => {});
} else if (connectDelayMs > 0) {
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
    await start();
  };
}
if (process.env.TASKCHEF_TEST_TRANSPORT_CLOSE_MS) {
  setTimeout(
    () => { void transport.close(); },
    Number(process.env.TASKCHEF_TEST_TRANSPORT_CLOSE_MS),
  );
}

const startupKeepAlive = process.env.TASKCHEF_TEST_CONNECT_NEVER === "1"
  ? setInterval(() => {}, 1_000)
  : null;
try {
  await runTaskChefMcpProcess({ server, transport });
} finally {
  if (startupKeepAlive) clearInterval(startupKeepAlive);
}
