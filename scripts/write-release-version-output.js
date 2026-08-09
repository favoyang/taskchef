#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) throw new Error("GITHUB_OUTPUT is required");

const manifest = JSON.parse(
  await readFile(path.resolve(".codex-plugin/plugin.json"), "utf8"),
);
if (
  typeof manifest.version !== "string"
  || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
) {
  throw new Error("plugin manifest version must be valid semver");
}

await appendFile(outputPath, `version=${manifest.version}\n`, "utf8");
