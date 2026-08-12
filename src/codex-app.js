import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const CODEX_COMMAND_TIMEOUT_MS = 10_000;

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

  let candidate = null;
  for (const pathCandidate of pathCandidates(env)) {
    candidate = await executable(pathCandidate);
    if (candidate) break;
  }
  if (!candidate) throw new Error("Codex CLI was not found in PATH; pass --codex-cli");
  if (!(await supportsAppCommand(candidate, run))) {
    throw new Error(`Codex CLI does not support the app command: ${candidate}`);
  }
  const bundled = candidate.includes(`${path.sep}Contents${path.sep}Resources${path.sep}`);
  return { path: candidate, source: bundled ? "desktop-path" : "path" };
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
