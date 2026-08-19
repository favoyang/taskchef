#!/usr/bin/env node

import { handleInitialPromptHook } from "../src/hook.js";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

try {
  const input = JSON.parse(raw);
  process.stdout.write(`${JSON.stringify(await handleInitialPromptHook(input))}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    continue: true,
    systemMessage: `TaskChef initial identity hook failed: ${error instanceof Error ? error.message : String(error)}`,
  })}\n`);
}
