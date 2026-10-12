#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDurableAtomic } from "../src/state-store.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

// Apply development identity to a staging copy, never to the release checkout.
export async function prepareMcpAppPreview(pluginRoot) {
  if (!pluginRoot) throw new Error("Pass a copied TaskChef development plugin folder.");
  const root = await realpath(resolve(pluginRoot));
  if (root === await realpath(sourceRoot)) throw new Error("Use a staging copy; the release checkout must retain its identity.");
  const manifestPath = join(root, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const mcpPath = join(root, ".mcp.json");
  const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
  if (manifest.name !== "taskchef-next") throw new Error("The target must already have the taskchef-next development identity.");
  const server = mcp.mcpServers?.[manifest.name] ?? mcp.mcpServers?.taskchef;
  if (!server || Object.keys(mcp.mcpServers).length !== 1) throw new Error("Expected one TaskChef MCP server.");
  manifest.name = "taskchef-next";
  manifest.interface = { ...manifest.interface, displayName: "TaskChef Dev" };
  if (manifest.interface.defaultPrompt) {
    manifest.interface.defaultPrompt = manifest.interface.defaultPrompt.map(prompt => prompt.replaceAll("$taskchef:", "$taskchef-next:"));
  }
  mcp.mcpServers = { "taskchef-next": server };
  await writeDurableAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeDurableAtomic(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  return { name: manifest.name, displayName: manifest.interface.displayName, version: manifest.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/prepare-mcp-app-preview.js <staging-plugin-folder>");
    console.log(JSON.stringify(await prepareMcpAppPreview(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
