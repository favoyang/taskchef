import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TASKCHEF_APP_NAME, TASKCHEF_VERSION } from "./version.js";
import { registerTaskChefApp } from "./mcp-app.js";

const sidebarSvg = readFileSync(new URL("../assets/taskchef-sidebar.svg", import.meta.url), "utf8");
const sidebarIcons = [["light", "#333333"], ["dark", "#dddddd"]].map(([theme, color]) => ({
  src: `data:image/svg+xml;base64,${Buffer.from(sidebarSvg.replace("<svg ", `<svg style="color:${color}" `)).toString("base64")}`,
  mimeType: "image/svg+xml", sizes: ["20x20"], theme,
}));

export function createTaskChefMcpServer(options = {}) {
  const server = new McpServer(
    { name: "taskchef", version: TASKCHEF_VERSION, icons: sidebarIcons },
    { instructions: `${TASKCHEF_APP_NAME} displays local Codex chats. Codex owns chat identity, history and execution state. Use native Codex tools to create or continue chats.` },
  );
  registerTaskChefApp(server, options);
  return server;
}
