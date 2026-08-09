#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("usage: sync-plugin-version.js <semver>");
}

const manifestPath = path.resolve(".codex-plugin/plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
