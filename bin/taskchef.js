#!/usr/bin/env node

import { runCli } from "../src/cli.js";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      error: {
        code: error.code ?? "ERROR",
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    })}\n`);
  } else {
    process.stderr.write(`taskchef: ${error.message}\n`);
  }
  process.exitCode = 1;
}
