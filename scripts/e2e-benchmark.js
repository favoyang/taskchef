#!/usr/bin/env node

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCodexThreadId } from "../src/delegation.js";

const BENCHMARK_NAME = "taskchef-executor-self-link-e2e";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESULT_FILENAME = new RegExp(
  `^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z-${BENCHMARK_NAME}\\.json$`,
);

function managedResultFilename(name) {
  if (!RESULT_FILENAME.test(name)) return false;
  const timestampPart = name.slice(0, -`-${BENCHMARK_NAME}.json`.length);
  const iso = `${timestampPart.slice(0, 13)}:${timestampPart.slice(14, 16)}:${timestampPart.slice(17)}`;
  try {
    timestamp(iso, "result filename timestamp");
    return true;
  } catch {
    return false;
  }
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function exact(value, keys, name) {
  object(value, name);
  const expected = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !expected.has(key));
  if (unexpected) throw new Error(`${name} has unsupported field: ${unexpected}`);
  const missing = keys.find((key) => !(key in value));
  if (missing) throw new Error(`${name} is missing field: ${missing}`);
  return value;
}

function string(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

function timestamp(value, name) {
  string(value, name);
  const milliseconds = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)
    || Number.isNaN(milliseconds)
    || new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${name} must be a canonical four-digit-year UTC timestamp`);
  }
  return milliseconds;
}

function uuid(value, name) {
  string(value, name);
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a lowercase full UUID`);
  return value;
}

function codexUuid(value, name) {
  return normalizeCodexThreadId(value, name);
}

export function normalizeBenchmarkResult(input, { requireDerived = false } = {}) {
  const value = structuredClone(object(input, "benchmark result"));
  if (!("summary" in value) && !requireDerived) value.summary = undefined;
  exact(value, [
    "schemaVersion", "benchmark", "taskchefVersion", "runId", "startedAt", "completedAt",
    "workload", "task", "turns", "events", "validation", "summary",
  ], "benchmark result");
  if (value.schemaVersion !== 2) throw new Error("schemaVersion must be 2");
  if (value.benchmark !== BENCHMARK_NAME) throw new Error(`benchmark must be ${BENCHMARK_NAME}`);
  string(value.taskchefVersion, "taskchefVersion");
  string(value.runId, "runId");
  const started = timestamp(value.startedAt, "startedAt");
  const completed = timestamp(value.completedAt, "completedAt");
  if (completed < started) throw new Error("completedAt must not precede startedAt");

  exact(value.workload, ["project", "title", "prompt"], "workload");
  for (const key of ["project", "title", "prompt"]) string(value.workload[key], `workload.${key}`);
  if (/<!--\s*taskchef_id=/i.test(value.workload.prompt)) throw new Error("workload.prompt must not contain a TaskChef marker");

  exact(value.task, ["taskId", "threadId", "clientThreadId", "recorded", "linked"], "task");
  uuid(value.task.taskId, "task.taskId");
  value.task.threadId = codexUuid(value.task.threadId, "task.threadId");
  if (value.task.clientThreadId !== null) {
    string(value.task.clientThreadId, "task.clientThreadId");
    if (!value.task.clientThreadId.startsWith("local:")) throw new Error("task.clientThreadId must be provisional");
  }
  for (const key of ["recorded", "linked"]) {
    if (typeof value.task[key] !== "boolean") throw new Error(`task.${key} must be boolean`);
  }
  if (!value.task.recorded || !value.task.linked) throw new Error("benchmark task must be recorded and self-linked");

  exact(value.turns, ["needsInput", "completion"], "turns");
  value.turns.needsInput = codexUuid(value.turns.needsInput, "turns.needsInput");
  value.turns.completion = codexUuid(value.turns.completion, "turns.completion");
  if (value.turns.completion <= value.turns.needsInput) {
    throw new Error("follow-up completion must use a newer turn ID");
  }

  const eventNames = ["preparedAt", "recordedAt", "createdAt", "linkedAt", "needsInputAt", "followedUpAt", "completedAt"];
  exact(value.events, eventNames, "events");
  let previous = started;
  for (const name of eventNames) {
    const current = timestamp(value.events[name], `events.${name}`);
    if (current < previous || current > completed) throw new Error("events must be ordered within the benchmark interval");
    previous = current;
  }
  if (Date.parse(value.events.recordedAt) > Date.parse(value.events.createdAt)) throw new Error("record must precede native creation");

  const validationNames = [
    "exactMarkerCorrelated", "noDispatcherPostCreateReads", "childIdentityVerified",
    "parentIdentityRejected", "linkRetryVerified", "needsInputVerified",
    "followUpTurnFresh", "dashboardDeepLinkVerified", "outputVerified",
  ];
  exact(value.validation, validationNames, "validation");
  for (const name of validationNames) {
    if (typeof value.validation[name] !== "boolean") throw new Error(`validation.${name} must be boolean`);
    if (!value.validation[name]) throw new Error(`validation.${name} must be true for a successful benchmark`);
  }

  const summary = {
    totalWallMs: completed - started,
    provisionalPath: value.task.clientThreadId !== null,
    linked: value.task.linked,
    freshFollowUp: value.turns.needsInput !== value.turns.completion,
  };
  if (requireDerived && value.summary === undefined) throw new Error("summary is required in a saved result");
  if (value.summary !== undefined) {
    exact(value.summary, Object.keys(summary), "summary");
    if (Object.entries(summary).some(([key, expected]) => value.summary[key] !== expected)) {
      throw new Error("summary does not match the derived benchmark summary");
    }
  }
  value.summary = summary;
  return value;
}

function timestampFilename(iso) {
  return iso.replaceAll(":", "-");
}

export async function writeBenchmarkResult(input, outputDirectory) {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const result = normalizeBenchmarkResult({ ...input, taskchefVersion: packageJson.version });
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${timestampFilename(result.startedAt)}-${BENCHMARK_NAME}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return { outputPath, result };
}

export async function cleanBenchmarkResults(outputDirectory) {
  const entries = await readdir(outputDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() || !managedResultFilename(entry.name)) continue;
    await unlink(path.join(outputDirectory, entry.name));
    removed.push(entry.name);
  }
  return removed.sort();
}

async function readJsonStdin() {
  if (process.stdin.isTTY) throw new Error("write requires non-interactive JSON on stdin");
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  if (input.trim() === "") throw new Error("expected benchmark JSON on stdin");
  return JSON.parse(input);
}

async function main(args) {
  const command = args[0];
  const target = path.resolve(args[1] ?? "reports/e2e-benchmarks");
  if (command === "write") {
    const { outputPath, result } = await writeBenchmarkResult(await readJsonStdin(), target);
    process.stdout.write(`${JSON.stringify({ outputPath, summary: result.summary })}\n`);
    return;
  }
  if (command === "validate") {
    const result = normalizeBenchmarkResult(JSON.parse(await readFile(target, "utf8")), { requireDerived: true });
    process.stdout.write(`${JSON.stringify({ inputPath: target, summary: result.summary })}\n`);
    return;
  }
  if (command === "clean") {
    process.stdout.write(`${JSON.stringify({ outputDirectory: target, removed: await cleanBenchmarkResults(target) })}\n`);
    return;
  }
  throw new Error("usage: e2e-benchmark.js <write|validate|clean> [path]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
