import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createTaskChefMcpServer } from "./mcp.js";
import { installParentLossMonitor } from "./process-lifecycle.js";

const CONNECTION_SHUTDOWN_GRACE_MS = 1_000;

export async function runTaskChefMcpProcess({
  server = createTaskChefMcpServer(),
  transport = new StdioServerTransport(),
  processObject = process,
  installParentMonitor = installParentLossMonitor,
} = {}) {
  let shutdownPromise = null;
  let parentMonitor = null;
  let resolveTerminal;
  let resolveConnectionSettled;
  const originalProtocolClose = server.server?.onclose;
  const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
  const connectionSettled = new Promise((resolve) => { resolveConnectionSettled = resolve; });
  const removeLifecycleListeners = () => {
    processObject.off("SIGINT", shutdown);
    processObject.off("SIGTERM", shutdown);
    processObject.stdin.off("end", shutdown);
    processObject.stdin.off("close", shutdown);
    if (server.server?.onclose === protocolClose) server.server.onclose = originalProtocolClose;
  };
  const protocolClose = () => {
    try { originalProtocolClose?.(); } finally { void shutdown(); }
  };
  if (server.server) server.server.onclose = protocolClose;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      try {
        await Promise.resolve().then(() => transport.close?.()).catch(() => {});
        let connectionTimer;
        await Promise.race([
          connectionSettled,
          new Promise((resolve) => {
            connectionTimer = setTimeout(resolve, CONNECTION_SHUTDOWN_GRACE_MS);
          }),
        ]);
        clearTimeout(connectionTimer);
        await server.close();
      } catch (error) {
        processObject.stderr.write(`TaskChef MCP shutdown failed: ${error.message}\n`);
        processObject.exitCode = 1;
      } finally {
        parentMonitor?.close();
        removeLifecycleListeners();
        resolveTerminal();
      }
    })();
    return shutdownPromise;
  };
  processObject.once("SIGINT", shutdown);
  processObject.once("SIGTERM", shutdown);
  processObject.stdin.once("end", shutdown);
  processObject.stdin.once("close", shutdown);
  parentMonitor = installParentMonitor({ onParentLoss: shutdown });
  const connection = server.connect(transport).then(
    () => ({ connected: true, error: null }),
    (error) => ({ connected: false, error }),
  ).finally(resolveConnectionSettled);
  const outcome = await Promise.race([
    connection,
    terminal.then(() => ({ terminated: true })),
  ]);
  if (outcome.terminated) return;
  if (outcome.error) {
    if (shutdownPromise) await shutdownPromise;
    else {
      parentMonitor.close();
      removeLifecycleListeners();
    }
    throw outcome.error;
  }
  await terminal;
}
