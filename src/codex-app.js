import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const CODEX_COMMAND_TIMEOUT_MS = 10_000;
const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function runCodex(run, filePath, args) {
  return run(filePath, args, { timeout: CODEX_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" });
}

async function executable(filePath) {
  try {
    await access(filePath, 1);
    return path.resolve(filePath);
  } catch {
    return null;
  }
}

function pathCandidates(env) {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, process.platform === "win32" ? "codex.exe" : "codex"));
}

function isDesktopBundleCandidate(filePath) {
  return filePath.includes(`${path.sep}Contents${path.sep}Resources${path.sep}`);
}

async function supportsAppCommand(filePath, run) {
  try {
    const { stdout, stderr } = await runCodex(run, filePath, ["app", "--help"]);
    return /(?:^|\n)Usage:\s+codex\s+app(?:\s|$)/.test(`${stdout}\n${stderr}`);
  } catch {
    return false;
  }
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
  for (const pathCandidate of candidates.filter(isDesktopBundleCandidate)) {
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
  return typeof threadId === "string" && CODEX_THREAD_ID_PATTERN.test(threadId);
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
