#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTaskChefMcpServer } from "../src/mcp.js";

const server = createTaskChefMcpServer();
await server.connect(new StdioServerTransport());

let shutdownPromise = null;
const shutdown = () => {
  shutdownPromise ??= server.close().catch((error) => {
    process.stderr.write(`TaskChef MCP shutdown failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  return shutdownPromise;
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
