import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const childPath = fileURLToPath(new URL("./mcp-lifecycle-child.js", import.meta.url));
const child = spawn(process.execPath, [childPath], {
  env: process.env,
  stdio: [process.stdin, "ignore", "inherit"],
});

process.stdout.write(`${JSON.stringify({ childPid: child.pid })}\n`);
process.once("SIGUSR1", () => process.exit(0));
