import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

const execFile = promisify(execFileCallback);
const CODEX_COMMAND_TIMEOUT_MS = 10_000;
const CODEX_COMMAND_MAX_BUFFER_BYTES = 64 * 1024;

function runCodex(run, filePath, args, timeout = CODEX_COMMAND_TIMEOUT_MS) {
  return run(filePath, args, {
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: CODEX_COMMAND_MAX_BUFFER_BYTES,
  });
}

// MCP callers can supply IDs; validate only the UUID boundary, not its version.
export function isCodexThreadDeepLinkId(threadId) {
  return z.string().uuid().safeParse(threadId).success;
}

export async function openThreadInCodex(threadId, options = {}) {
  if (!isCodexThreadDeepLinkId(threadId)) {
    throw new Error("Codex thread ID is not supported by the desktop deep link");
  }
  const url = `codex://threads/${encodeURIComponent(threadId)}`;
  await openDesktopLink(url, options);
  return { status: "requested", mechanism: "codex-deep-link", threadId, url };
}

export async function openPluginSettingsInCodex(url, options = {}) {
  if (typeof url !== "string") throw new Error("Cannot resolve the installed plugin settings page. Open TaskChef from Plugins.");
  const link = new URL(url);
  if (link.protocol !== "codex:" || link.hostname !== "plugins" || !/^\/[^/]+$/.test(link.pathname)
    || link.username || link.password || link.port || link.hash
    || [...link.searchParams.keys()].some((key) => key !== "marketplacePath")
    || link.searchParams.getAll("marketplacePath").length !== 1
    || !path.isAbsolute(link.searchParams.get("marketplacePath"))) {
    throw new Error("Cannot resolve the installed plugin settings page. Open TaskChef from Plugins.");
  }
  await openDesktopLink(url, options);
  return { status: "requested", mechanism: "codex-deep-link", url };
}

async function openDesktopLink(url, options) {
  const run = options.run ?? execFile;
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    await runCodex(run, "/usr/bin/open", [url]);
  } else if (platform === "win32") {
    await runCodex(run, "rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  } else {
    await runCodex(run, "xdg-open", [url]);
  }
}
