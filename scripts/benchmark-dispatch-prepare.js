#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { addProject, initializeWorkspace } from "../index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repositoryRoot, "bin", "taskchef.js");
const sampleCount = Number.parseInt(process.env.TASKCHEF_BENCHMARK_SAMPLES ?? "30", 10);
if (!Number.isInteger(sampleCount) || sampleCount < 1) {
  throw new Error("TASKCHEF_BENCHMARK_SAMPLES must be a positive integer");
}

const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-dispatch-benchmark-"));
const workspace = path.join(root, "workspace");
const project = path.join(root, "project");
await mkdir(project);
await initializeWorkspace(workspace);
await addProject(workspace, { name: "benchmark", path: project, githubRepos: [] });

function runTaskChef(args) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

function measure(operation) {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
}

const legacy = [];
const prepared = [];
for (let index = 0; index < sampleCount; index += 1) {
  legacy.push(measure(() => {
    runTaskChef(["workspace", "path", "--json", "--workspace", workspace]);
    runTaskChef(["project", "list", "--json", "--workspace", workspace]);
    execFileSync(process.execPath, [
      "-e",
      "const { randomUUID } = require('node:crypto'); JSON.stringify({ taskId: randomUUID(), preparedAt: new Date().toISOString() });",
    ]);
  }));
  prepared.push(measure(() => {
    const result = JSON.parse(runTaskChef([
      "dispatch", "prepare", "--json", "--workspace", workspace,
    ]));
    if (result.projectCount !== 1 || !result.marker.includes(result.taskId)) {
      throw new Error("dispatch prepare returned an invalid benchmark result");
    }
  }));
}

function statistics(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.floor((sorted.length - 1) * value)];
  return {
    samples: sorted.length,
    medianMs: Number(percentile(0.5).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    minMs: Number(sorted[0].toFixed(2)),
    maxMs: Number(sorted.at(-1).toFixed(2)),
  };
}

const legacyStats = statistics(legacy);
const preparedStats = statistics(prepared);
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  comparison: {
    legacy: {
      description: "workspace path + project list + external UUID/timestamp process",
      processCalls: 3,
      ...legacyStats,
    },
    dispatchPrepare: {
      description: "dispatch prepare",
      processCalls: 1,
      ...preparedStats,
    },
    savedProcessCalls: 2,
    medianSpeedup: Number((legacyStats.medianMs / preparedStats.medianMs).toFixed(2)),
    medianReductionPercent: Number(
      ((1 - preparedStats.medianMs / legacyStats.medianMs) * 100).toFixed(1),
    ),
  },
}, null, 2)}\n`);
