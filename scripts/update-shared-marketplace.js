#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const NPM_REGISTRY = "https://registry.npmjs.org";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const execFile = promisify(execFileCallback);
const SKILL_NAMES = [
  "taskchef-bootstrap",
  "taskchef-dashboard",
  "taskchef-delegate",
  "taskchef-executor",
  "taskchef-copilot",
];
const REQUIRED_PLUGIN_FILES = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "assets/taskchef-dark.svg",
  "assets/taskchef.svg",
  "bin/taskchef.js",
  "mcp/server.js",
  "node_modules/@modelcontextprotocol/sdk/package.json",
  "node_modules/proper-lockfile/package.json",
  "node_modules/zod/package.json",
  "src/cli.js",
  "src/delegation.js",
  "src/mcp.js",
  "src/workspace-path.js",
  "src/workspace.js",
  ...SKILL_NAMES.flatMap((name) => [
    `skills/${name}/SKILL.md`,
    `skills/${name}/agents/openai.yaml`,
  ]),
];

function requireVersion(version) {
  if (!SEMVER.test(version)) throw new Error(`invalid TaskChef release version: ${version}`);
  return version;
}

function taskChefEntry(marketplace) {
  if (!marketplace || !Array.isArray(marketplace.plugins)) {
    throw new Error("marketplace must contain a plugins array");
  }
  const matches = marketplace.plugins.filter((plugin) => plugin?.name === "taskchef");
  if (matches.length !== 1) {
    throw new Error(`expected exactly one taskchef marketplace entry, found ${matches.length}`);
  }
  return matches[0];
}

function replaceSource(marketplace, source) {
  const entry = taskChefEntry(marketplace);
  const unchanged = JSON.stringify(entry.source) === JSON.stringify(source);
  entry.source = source;
  return { marketplace, changed: !unchanged };
}

export function pinTaskChefNpmSource(marketplace, version) {
  requireVersion(version);
  return replaceSource(marketplace, {
    source: "npm",
    package: "taskchef",
    version,
    registry: NPM_REGISTRY,
  });
}

export function preserveTaskChefInstallableSource(marketplace) {
  const entry = taskChefEntry(marketplace);
  if (entry.source?.source === "npm") return { marketplace, changed: false };
  return replaceSource(marketplace, {
    source: "url",
    url: "https://github.com/favoyang/taskchef.git",
    ref: "main",
  });
}

export function validatePublishedPluginPackage(packages, version) {
  requireVersion(version);
  if (!Array.isArray(packages) || packages.length !== 1) {
    throw new Error("npm pack must return exactly one TaskChef package");
  }
  const packed = packages[0];
  if (packed.id !== `taskchef@${version}` || !Array.isArray(packed.files)) {
    throw new Error(`npm pack did not resolve taskchef@${version}`);
  }
  const files = new Map(packed.files.map((file) => [file?.path, file]));
  for (const requiredPath of REQUIRED_PLUGIN_FILES) {
    if (!files.has(requiredPath)) {
      throw new Error(`published taskchef@${version} is missing ${requiredPath}`);
    }
  }
  if ((files.get("bin/taskchef.js").mode & 0o111) === 0) {
    throw new Error(`published taskchef@${version} bin/taskchef.js is not executable`);
  }
  return packed;
}

export function validateSkillFrontmatter(content, skillName) {
  const frontmatterSource = content.match(/^---\n([\s\S]+?)\n---(?:\n|$)/)?.[1];
  if (!frontmatterSource) {
    throw new Error(`published ${skillName} skill has invalid frontmatter`);
  }
  let frontmatter;
  try {
    frontmatter = parseYaml(frontmatterSource);
  } catch (error) {
    throw new Error(`published ${skillName} skill has invalid YAML: ${error.message}`);
  }
  if (!frontmatter || frontmatter.name !== skillName) {
    throw new Error(`published ${skillName} skill has the wrong name`);
  }
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    throw new Error(`published ${skillName} skill has no description`);
  }
  return frontmatter;
}

export async function validateExtractedPlugin(pluginRoot, version, execFileImpl = execFile) {
  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  if (manifest.name !== "taskchef") throw new Error("published plugin name is not taskchef");
  if (manifest.version !== version) {
    throw new Error(`published plugin manifest version is ${manifest.version}, expected ${version}`);
  }
  if (manifest.skills !== "./skills/") {
    throw new Error(`published plugin skills path is ${manifest.skills}, expected ./skills/`);
  }
  if (manifest.mcpServers !== "./.mcp.json") {
    throw new Error(
      `published plugin MCP path is ${manifest.mcpServers}, expected ./.mcp.json`,
    );
  }
  const mcpConfig = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
  assertTaskChefMcpConfig(mcpConfig);
  for (const skillName of SKILL_NAMES) {
    const skill = await readFile(path.join(pluginRoot, "skills", skillName, "SKILL.md"), "utf8");
    validateSkillFrontmatter(skill, skillName);
  }
  const { stdout } = await execFileImpl(
    process.execPath,
    [path.join(pluginRoot, "bin", "taskchef.js"), "help"],
    { cwd: pluginRoot, maxBuffer: 1024 * 1024 },
  );
  if (!stdout.includes("taskchef workspace init")) {
    throw new Error("published TaskChef CLI help smoke test failed");
  }
  return manifest;
}

function assertTaskChefMcpConfig(config) {
  const server = config?.mcpServers?.taskchef;
  if (server?.command !== "node") throw new Error("published TaskChef MCP command is not node");
  if (JSON.stringify(server.args) !== JSON.stringify(["./mcp/server.js"])) {
    throw new Error("published TaskChef MCP server path is invalid");
  }
  if (server.cwd !== ".") throw new Error("published TaskChef MCP cwd is not plugin-relative");
}

export async function verifyPublishedPluginArchive(version, execFileImpl = execFile) {
  requireVersion(version);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "taskchef-published-plugin-"));
  try {
    const { stdout } = await execFileImpl(
      "npm",
      ["pack", "--json", "--pack-destination", temporaryRoot, `taskchef@${version}`],
      { maxBuffer: 1024 * 1024 },
    );
    const packed = validatePublishedPluginPackage(JSON.parse(stdout), version);
    const archivePath = path.join(temporaryRoot, packed.filename);
    const extractedRoot = path.join(temporaryRoot, "extracted");
    await mkdir(extractedRoot);
    await execFileImpl("tar", ["-xzf", archivePath, "-C", extractedRoot]);
    return await validateExtractedPlugin(path.join(extractedRoot, "package"), version, execFileImpl);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readLatestVersion(execFileImpl = execFile) {
  const { stdout } = await execFileImpl(
    "npm",
    ["view", "taskchef", "version", "--json"],
    { maxBuffer: 1024 * 1024 },
  );
  return requireVersion(JSON.parse(stdout));
}

export async function resolveExpectedPublishedPlugin(expectedVersion, {
  attempts = 12,
  delayMs = 5000,
  readVersionImpl = readLatestVersion,
  verifyVersionImpl = verifyPublishedPluginArchive,
  waitImpl = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
} = {}) {
  requireVersion(expectedVersion);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const latestVersion = await readVersionImpl();
      if (latestVersion !== expectedVersion) {
        throw new Error(`npm latest is ${latestVersion}, expected ${expectedVersion}`);
      }
      await verifyVersionImpl(expectedVersion);
      return expectedVersion;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await waitImpl(delayMs);
    }
  }
  throw new Error(
    `could not validate taskchef@${expectedVersion} as npm latest after ${attempts} attempts: ${lastError?.message}`,
  );
}

async function writeMarketplace(marketplacePath, marketplace) {
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
}

export async function updateSharedMarketplaceFile(marketplacePath, version) {
  if (!marketplacePath) throw new Error("marketplace path is required");
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  const updated = pinTaskChefNpmSource(marketplace, version);
  if (updated.changed) await writeMarketplace(marketplacePath, updated.marketplace);
  return { changed: updated.changed, version };
}

export async function preserveSharedMarketplaceFile(marketplacePath) {
  if (!marketplacePath) throw new Error("marketplace path is required");
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  const updated = preserveTaskChefInstallableSource(marketplace);
  if (updated.changed) await writeMarketplace(marketplacePath, updated.marketplace);
  return { changed: updated.changed };
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  return writeFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, { flag: "a" });
}

async function main() {
  const marketplacePath = process.argv[2];
  const expectedVersion = process.argv[3];
  if (!marketplacePath || !expectedVersion) {
    throw new Error("usage: update-shared-marketplace.js <marketplace.json> <expected-version>");
  }
  try {
    const version = await resolveExpectedPublishedPlugin(expectedVersion);
    const result = await updateSharedMarketplaceFile(marketplacePath, version);
    await setOutput("npm_ready", "true");
    process.stdout.write(
      result.changed
        ? `Updated shared marketplace to taskchef ${result.version}.\n`
        : `Shared marketplace already uses taskchef ${result.version}.\n`,
    );
  } catch (error) {
    const fallback = await preserveSharedMarketplaceFile(marketplacePath);
    await setOutput("npm_ready", "false");
    process.stderr.write(`${error.message}\n`);
    process.stdout.write(
      fallback.changed
        ? "Preserved TaskChef availability through Git main.\n"
        : "Preserved the existing installable TaskChef source.\n",
    );
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPoint === import.meta.url) await main();
