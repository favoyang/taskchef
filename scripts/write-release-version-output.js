#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

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

const tag = `v${manifest.version}`;
// A manual run may repair a failed catalog update after main has advanced.
// npm archive verification still gates the catalog write.
const args = process.env.RETRY_PUBLISHED_VERSION === "true"
  ? ["tag", "--list", tag]
  : ["tag", "--points-at", "HEAD", "--list", tag];
const { stdout } = await execFile("git", args);
const releasedVersion = stdout.trim() === tag ? manifest.version : "";
await appendFile(outputPath, `version=${releasedVersion}\n`, "utf8");
