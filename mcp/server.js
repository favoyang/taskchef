#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTaskChefMcpServer } from "../src/mcp.js";

const server = createTaskChefMcpServer();
await server.connect(new StdioServerTransport());
