import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Codex extracts bundled plugins without installing platform-specific dependencies.
// The release package must include native credential-store bindings for each desktop target.
const root = fileURLToPath(new URL("../", import.meta.url));
const targets = ["darwin-arm64", "darwin-x64", "win32-arm64-msvc", "win32-x64-msvc", "linux-arm64-gnu", "linux-arm64-musl", "linux-x64-gnu", "linux-x64-musl"];
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).dependencies["@napi-rs/keyring"];
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Keyring must have an exact release version.");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this packaging step through npm run prepack.");
const temporary = await mkdtemp(join(tmpdir(), "taskchef-keyring-package-"));
try {
  await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true }));
  await promisify(execFile)(process.execPath, [npmCli,
    "install", "--prefix", temporary, "--cache", join(temporary, "cache"),
    "--registry", "https://registry.npmjs.org", "--force", "--dry-run=false", "--global=false", "--package-lock=false", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund",
    ...targets.map((target) => `@napi-rs/keyring-${target}@${version}`),
  ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  for (const target of targets) {
    const name = `@napi-rs/keyring-${target}`;
    await cp(join(temporary, "node_modules", name), join(root, "node_modules", name), { recursive: true });
  }
  console.error("Bundled GitHub credential-store bindings for macOS, Windows, and Linux.");
} finally { await rm(temporary, { recursive: true, force: true }); }
