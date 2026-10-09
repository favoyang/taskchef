#!/usr/bin/env node

import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDurableAtomic } from "../src/state-store.js";

const builtHtml = fileURLToPath(new URL("../src/mcp-app/dist/index.html", import.meta.url));

// UI-only development update: keep the plugin version and running MCP process.
export async function updateMcpAppPreview(pluginRoot, sourceHtml = builtHtml) {
  if (!pluginRoot) throw new Error("Pass the installed TaskChef Next plugin folder used by the running app.");
  const root = await realpath(resolve(pluginRoot));
  const manifest = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"));
  if (manifest.name !== "taskchef-next") throw new Error("The target must be an installed TaskChef Next preview.");
  const target = join(root, "src", "mcp-app", "dist", "index.html");
  let metadata;
  try { metadata = await lstat(target); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("The preview HTML is missing. Use the folder of the running installation; do not reinstall for a UI-only update.");
    throw error;
  }
  if (!metadata.isFile() || await realpath(dirname(target)) !== dirname(target)) {
    throw new Error("The preview HTML must be a regular file inside the plugin folder.");
  }
  const html = await readFile(sourceHtml, "utf8");
  if (!/^<!doctype html>/i.test(html.trimStart())) throw new Error("Build the MCP app before updating the preview.");
  const changed = await readFile(target, "utf8") !== html;
  if (changed) await writeDurableAtomic(target, html, { mode: metadata.mode & 0o777 });
  return { target, version: manifest.version, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: npm run update:mcp-app-preview -- <installed-plugin-folder>");
    const result = await updateMcpAppPreview(process.argv[2]);
    console.log(`${result.changed ? "Updated" : "Already current"}: TaskChef Next ${result.version}`);
    console.log("Right-click TaskChef Next in the Codex sidebar and choose Refresh to reload the UI.");
    console.log("The app's own Refresh button updates data only. Server changes still need a plugin/runtime update.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
