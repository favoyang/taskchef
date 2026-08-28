import { execFile as execFileCallback } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeCodexThreadId } from "./delegation.js";

const execFile = promisify(execFileCallback);
const CODEX_COMMAND_TIMEOUT_MS = 10_000;
const CODEX_ARCHIVE_TIMEOUT_MS = 4_000;
const CODEX_COMMAND_MAX_BUFFER_BYTES = 64 * 1024;
const OPENAI_TEAM_IDENTIFIER = "2DC432GLL2";

function runCodex(run, filePath, args, timeout = CODEX_COMMAND_TIMEOUT_MS) {
  return run(filePath, args, {
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: CODEX_COMMAND_MAX_BUFFER_BYTES,
  });
}

async function executable(filePath) {
  try {
    await access(filePath, 1);
    return path.resolve(filePath);
  } catch {
    return null;
  }
}

function pathCandidates(env, platform = process.platform) {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, platform === "win32" ? "codex.exe" : "codex"));
}

function isDesktopBundleCandidate(filePath, platform = process.platform) {
  if (platform !== "darwin" || path.basename(filePath) !== "codex") return false;
  const resources = path.dirname(filePath);
  const contents = path.dirname(resources);
  const application = path.dirname(contents);
  return path.basename(resources) === "Resources"
    && path.basename(contents) === "Contents"
    && new Set(["ChatGPT.app", "Codex.app"]).has(path.basename(application));
}

function defaultDesktopBundleCandidates(env, platform) {
  if (platform !== "darwin") return [];
  const applicationRoots = ["/Applications"];
  if (env.HOME) applicationRoots.push(path.join(env.HOME, "Applications"));
  return applicationRoots.flatMap((root) => [
    path.join(root, "ChatGPT.app", "Contents", "Resources", "codex"),
    path.join(root, "Codex.app", "Contents", "Resources", "codex"),
  ]);
}

async function supportsAppCommand(filePath, run) {
  try {
    const { stdout, stderr } = await runCodex(run, filePath, ["app", "--help"]);
    return /(?:^|\n)Usage:\s+codex\s+app(?:\s|$)/.test(`${stdout}\n${stderr}`);
  } catch {
    return false;
  }
}

async function supportsArchiveCommand(filePath, run) {
  try {
    const { stdout, stderr } = await runCodex(run, filePath, ["archive", "--help"]);
    return /(?:^|\n)Usage:\s+codex\s+archive(?:\s|$)/.test(`${stdout}\n${stderr}`);
  } catch {
    return false;
  }
}

async function hasOpenAiBundleIdentity(applicationPath) {
  try {
    const { stderr } = await runCodex(
      execFile,
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", applicationPath],
    );
    return new RegExp(`(?:^|\\n)TeamIdentifier=${OPENAI_TEAM_IDENTIFIER}(?:\\n|$)`)
      .test(stderr);
  } catch {
    return false;
  }
}

export async function discoverBundledCodexCli({
  candidates = null,
  env = process.env,
  platform = process.platform,
  run = execFile,
  inspectBundle = hasOpenAiBundleIdentity,
} = {}) {
  const bundledCandidates = candidates ?? defaultDesktopBundleCandidates(env, platform);
  for (const filePath of new Set(bundledCandidates.map((candidate) => path.resolve(candidate)))) {
    const executableCandidate = await executable(filePath);
    const candidate = executableCandidate === null ? null : await realpath(executableCandidate);
    const applicationPath = candidate === null ? null : path.dirname(path.dirname(path.dirname(candidate)));
    if (candidate && isDesktopBundleCandidate(candidate, platform)
      && await inspectBundle(applicationPath)
      && await supportsArchiveCommand(candidate, run)) {
      return { path: candidate, source: "desktop-bundle" };
    }
  }
  throw new Error("Chat archiving requires the Codex CLI bundled with the ChatGPT or Codex desktop app");
}

export async function discoverCodexCli({
  explicit = null,
  env = process.env,
  run = execFile,
} = {}) {
  const override = explicit ?? env.TASKCHEF_CODEX_CLI ?? null;
  if (override !== null) {
    const candidate = await executable(path.resolve(override));
    if (!candidate) throw new Error(`Codex CLI is not executable: ${override}`);
    if (!(await supportsAppCommand(candidate, run))) {
      throw new Error(`Codex CLI does not support the app command: ${candidate}`);
    }
    return { path: candidate, source: explicit !== null ? "explicit" : "environment" };
  }

  const candidates = pathCandidates(env);
  for (const pathCandidate of candidates.filter((candidate) => isDesktopBundleCandidate(candidate))) {
    const candidate = await executable(pathCandidate);
    if (candidate && await supportsAppCommand(candidate, run)) {
      return { path: candidate, source: "desktop-path" };
    }
  }

  let candidate = null;
  for (const pathCandidate of candidates) {
    candidate = await executable(pathCandidate);
    if (candidate) break;
  }
  if (!candidate) throw new Error("Codex CLI was not found in PATH; pass --codex-cli");
  if (!(await supportsAppCommand(candidate, run))) {
    throw new Error(`Codex CLI does not support the app command: ${candidate}`);
  }
  return { path: candidate, source: "path" };
}

export async function openWorkspaceInCodex(workspace, options = {}) {
  const run = options.run ?? execFile;
  const cli = await discoverCodexCli({ ...options, run });
  await runCodex(run, cli.path, ["app", workspace]);
  return {
    status: "requested",
    mechanism: "codex-app",
    codexCli: cli.path,
    codexCliSource: cli.source,
    workspace,
  };
}

export function isCodexThreadDeepLinkId(threadId) {
  try {
    normalizeCodexThreadId(threadId);
    return true;
  } catch {
    return false;
  }
}

export async function openThreadInCodex(threadId, options = {}) {
  if (!isCodexThreadDeepLinkId(threadId)) {
    throw new Error("Codex thread ID is not supported by the desktop deep link");
  }
  const run = options.run ?? execFile;
  const platform = options.platform ?? process.platform;
  const url = `codex://threads/${encodeURIComponent(threadId)}`;
  if (platform === "darwin") {
    await runCodex(run, "/usr/bin/open", [url]);
  } else if (platform === "win32") {
    await runCodex(run, "rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  } else {
    await runCodex(run, "xdg-open", [url]);
  }
  return { status: "requested", mechanism: "codex-deep-link", threadId, url };
}

export async function archiveThreadInCodex(threadId, options = {}) {
  if (!isCodexThreadDeepLinkId(threadId)) {
    throw new Error("Codex thread ID is not supported by chat archiving");
  }
  const run = options.run ?? execFile;
  const cli = options.cli ?? await discoverBundledCodexCli({ ...options, run });
  await runCodex(
    run,
    cli.path,
    ["archive", threadId],
    options.timeoutMs ?? CODEX_ARCHIVE_TIMEOUT_MS,
  );
  return {
    status: "archived",
    mechanism: "codex-archive-cli",
    codexCli: cli.path,
    codexCliSource: cli.source,
    threadId,
  };
}
