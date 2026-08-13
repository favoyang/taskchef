#!/usr/bin/env node

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BENCHMARK_NAME = "taskchef-delegate-e2e";
const STAGE_NAMES = [
  "prepare-and-list-projects",
  "create-thread",
  "record-task",
  "resolve-provisional",
];
const STAGE_OUTCOMES = Object.freeze({
  "prepare-and-list-projects": new Set(["success", "failed"]),
  "create-thread": new Set(["durable", "provisional", "failed"]),
  "record-task": new Set(["recorded", "failed"]),
  "resolve-provisional": new Set(["native", "discovered", "unresolved", "failed"]),
});
const RESOLUTIONS = new Set(["immediate", "native", "discovered", "unresolved"]);
const RESULT_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-taskchef-delegate-e2e\.json$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function requireExactKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${name} has unknown field ${unknown[0]}`);
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function timestamp(value, name) {
  requireString(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${name} must use a four-digit UTC year`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
  }
  return milliseconds;
}

function nullableString(value, name) {
  if (value === null) return null;
  return requireString(value, name);
}

function managedResultFilename(name) {
  if (!RESULT_FILENAME_PATTERN.test(name)) return false;
  const timestampPart = name.slice(0, -`-${BENCHMARK_NAME}.json`.length);
  const iso = `${timestampPart.slice(0, 13)}:${timestampPart.slice(14, 16)}:${timestampPart.slice(17)}`;
  try {
    timestamp(iso, "result filename timestamp");
    return true;
  } catch {
    return false;
  }
}

function requireNonnegativeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative number`);
  }
  return value;
}

function normalizeObservations(
  input,
  startedMs,
  completedMs,
  preparationStage,
  creationStage,
  recordingStage,
  resolutionStage,
  resolutionAttempts,
) {
  if (input === undefined) return undefined;
  const observations = requireObject(input, "observations");
  requireExactKeys(observations, [
    "preparation",
    "resolutionSnapshots",
    "validationDurationMs",
    "candidateMetadata",
  ], "observations");
  const result = {};
  if (observations.preparation !== undefined) {
    const preparation = requireObject(observations.preparation, "observations.preparation");
    requireExactKeys(preparation, ["dispatchPrepareMs", "nativeProjectListMs"], "observations.preparation");
    result.preparation = {
      dispatchPrepareMs: requireNonnegativeNumber(preparation.dispatchPrepareMs, "observations.preparation.dispatchPrepareMs"),
      nativeProjectListMs: requireNonnegativeNumber(preparation.nativeProjectListMs, "observations.preparation.nativeProjectListMs"),
    };
    const preparationDurationMs = timestamp(preparationStage.completedAt, "prepare-and-list-projects.completedAt") -
      timestamp(preparationStage.startedAt, "prepare-and-list-projects.startedAt");
    if (Object.values(result.preparation).some((durationMs) => durationMs > preparationDurationMs)) {
      throw new Error("observations.preparation durations must fit within the preparation stage");
    }
  }
  if (observations.resolutionSnapshots !== undefined) {
    if (!Array.isArray(observations.resolutionSnapshots)) {
      throw new Error("observations.resolutionSnapshots must be an array");
    }
    let previousSnapshotStartedMs = null;
    let previousSnapshotCompletedMs = null;
    result.resolutionSnapshots = observations.resolutionSnapshots.map((snapshot, index) => {
      requireObject(snapshot, `observations.resolutionSnapshots[${index}]`);
      requireExactKeys(snapshot, [
        "attempt", "startedAt", "completedAt", "recentTaskCount", "candidateCount", "exactMatchCount",
        "resolveWriteMs", "resolveWriteOutcome",
      ], `observations.resolutionSnapshots[${index}]`);
      if (!Number.isInteger(snapshot.attempt) || snapshot.attempt !== index + 1 || snapshot.attempt > resolutionAttempts) {
        throw new Error(`observations.resolutionSnapshots[${index}].attempt must be sequential and within resolutionAttempts`);
      }
      const snapshotStartedMs = timestamp(snapshot.startedAt, `observations.resolutionSnapshots[${index}].startedAt`);
      const snapshotCompletedMs = timestamp(snapshot.completedAt, `observations.resolutionSnapshots[${index}].completedAt`);
      const resolutionStartedMs = resolutionStage ? timestamp(resolutionStage.startedAt, "resolve-provisional.startedAt") : null;
      const resolutionCompletedMs = resolutionStage ? timestamp(resolutionStage.completedAt, "resolve-provisional.completedAt") : null;
      if (
        resolutionStartedMs === null || snapshotStartedMs < resolutionStartedMs ||
        snapshotCompletedMs < snapshotStartedMs || snapshotCompletedMs > resolutionCompletedMs ||
        snapshotStartedMs < startedMs || snapshotCompletedMs > completedMs
      ) {
        throw new Error(`observations.resolutionSnapshots[${index}] must fall within the resolution stage`);
      }
      const firstCheckpointMs = Math.max(
        timestamp(creationStage.completedAt, "create-thread.completedAt") + 10_000,
        timestamp(recordingStage.completedAt, "record-task.completedAt"),
      );
      if (index === 0 && snapshotStartedMs < firstCheckpointMs) {
        throw new Error("the first resolution snapshot must respect the 10-second catch-up checkpoint");
      }
      if (previousSnapshotCompletedMs !== null && snapshotStartedMs < previousSnapshotCompletedMs) {
        throw new Error("resolutionSnapshots must be ordered and non-overlapping");
      }
      if (previousSnapshotStartedMs !== null && snapshotStartedMs - previousSnapshotStartedMs < 20_000) {
        throw new Error("resolutionSnapshots must start at least 20 seconds apart");
      }
      for (const name of ["recentTaskCount", "candidateCount", "exactMatchCount", "resolveWriteMs"]) {
        requireNonnegativeNumber(snapshot[name], `observations.resolutionSnapshots[${index}].${name}`);
      }
      if (!["not-attempted", "succeeded", "failed"].includes(snapshot.resolveWriteOutcome)) {
        throw new Error(`observations.resolutionSnapshots[${index}].resolveWriteOutcome is invalid`);
      }
      if ((snapshot.exactMatchCount === 1) !== (snapshot.resolveWriteOutcome !== "not-attempted")) {
        throw new Error(`observations.resolutionSnapshots[${index}] resolve write must agree with exact matches`);
      }
      if (snapshot.resolveWriteOutcome === "not-attempted" && snapshot.resolveWriteMs !== 0) {
        throw new Error(`observations.resolutionSnapshots[${index}].resolveWriteMs must be zero when no write was attempted`);
      }
      if (!Number.isInteger(snapshot.recentTaskCount) || !Number.isInteger(snapshot.candidateCount) || !Number.isInteger(snapshot.exactMatchCount)) {
        throw new Error(`observations.resolutionSnapshots[${index}] counts must be integers`);
      }
      if (snapshot.recentTaskCount > 50) {
        throw new Error(`observations.resolutionSnapshots[${index}].recentTaskCount must not exceed 50`);
      }
      if (snapshot.candidateCount > snapshot.recentTaskCount || snapshot.exactMatchCount > snapshot.candidateCount) {
        throw new Error(`observations.resolutionSnapshots[${index}] counts are inconsistent`);
      }
      if (snapshot.resolveWriteMs > snapshotCompletedMs - snapshotStartedMs) {
        throw new Error(`observations.resolutionSnapshots[${index}].resolveWriteMs exceeds snapshot duration`);
      }
      previousSnapshotStartedMs = snapshotStartedMs;
      previousSnapshotCompletedMs = snapshotCompletedMs;
      return { ...snapshot };
    });
  }
  if (observations.validationDurationMs !== undefined) {
    result.validationDurationMs = requireNonnegativeNumber(observations.validationDurationMs, "observations.validationDurationMs");
    const finalStage = resolutionStage ?? recordingStage ?? creationStage ?? preparationStage;
    const postWorkflowMs = completedMs - timestamp(finalStage.completedAt, `${finalStage.name}.completedAt`);
    if (result.validationDurationMs > postWorkflowMs) {
      throw new Error("observations.validationDurationMs must fit after the workflow stages");
    }
  }
  if (observations.candidateMetadata !== undefined) {
    const metadata = requireObject(observations.candidateMetadata, "observations.candidateMetadata");
    const names = ["targetProjectIdPresent", "targetCreatedAtPresent", "targetEnvironmentPresent", "targetCwdPresent"];
    requireExactKeys(metadata, names, "observations.candidateMetadata");
    for (const name of names) {
      if (typeof metadata[name] !== "boolean") throw new Error(`observations.candidateMetadata.${name} must be boolean`);
    }
    result.candidateMetadata = { ...metadata };
  }
  return result;
}

export function normalizeBenchmarkResult(input, { requireDerived = false } = {}) {
  const value = structuredClone(requireObject(input, "benchmark result"));
  requireExactKeys(value, [
    "schemaVersion", "benchmark", "taskchefVersion", "runId", "startedAt", "completedAt",
    "workload", "task", "stages", "validation", "observations", "summary",
  ], "benchmark result");
  if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (value.benchmark !== BENCHMARK_NAME) {
    throw new Error(`benchmark must be ${BENCHMARK_NAME}`);
  }
  requireString(value.taskchefVersion, "taskchefVersion");
  if (!SEMVER_PATTERN.test(value.taskchefVersion)) throw new Error("taskchefVersion must be a semantic version");
  requireString(value.runId, "runId");
  const startedMs = timestamp(value.startedAt, "startedAt");
  const completedMs = timestamp(value.completedAt, "completedAt");
  if (completedMs < startedMs) throw new Error("completedAt must not precede startedAt");

  const workload = requireObject(value.workload, "workload");
  requireExactKeys(workload, ["project", "title", "prompt"], "workload");
  requireString(workload.project, "workload.project");
  requireString(workload.title, "workload.title");
  requireString(workload.prompt, "workload.prompt");
  if (/<!--\s*taskchef_id=/i.test(workload.prompt)) {
    throw new Error("workload.prompt must not contain a TaskChef marker");
  }

  const task = requireObject(value.task, "task");
  requireExactKeys(task, [
    "taskId", "threadId", "clientThreadId", "recorded", "resolution", "resolutionAttempts",
  ], "task");
  task.taskId = nullableString(task.taskId, "task.taskId");
  if (task.taskId !== null && !UUID_PATTERN.test(task.taskId)) {
    throw new Error("task.taskId must be a lowercase UUID");
  }
  task.threadId = nullableString(task.threadId, "task.threadId");
  task.clientThreadId = nullableString(task.clientThreadId, "task.clientThreadId");
  if (task.threadId !== null && task.threadId.trim().toLowerCase().startsWith("local:")) {
    throw new Error("task.threadId must not use the provisional local: namespace");
  }
  if (task.threadId !== null && task.threadId === task.clientThreadId) {
    throw new Error("task.threadId must differ from task.clientThreadId");
  }
  if (typeof task.recorded !== "boolean") throw new Error("task.recorded must be boolean");
  requireString(task.resolution, "task.resolution");
  if (!RESOLUTIONS.has(task.resolution)) throw new Error("task.resolution is invalid");
  if (!Number.isInteger(task.resolutionAttempts) || task.resolutionAttempts < 0) {
    throw new Error("task.resolutionAttempts must be a nonnegative integer");
  }
  if (task.resolutionAttempts > 2) throw new Error("task.resolutionAttempts must not exceed 2");

  if (!Array.isArray(value.stages)) throw new Error("stages must be an array");
  const stagesByName = new Map();
  let previousCompletedMs = startedMs;
  for (const [index, stage] of value.stages.entries()) {
    requireObject(stage, `stages[${index}]`);
    requireExactKeys(stage, ["name", "startedAt", "completedAt", "outcome", "durationMs"], `stages[${index}]`);
    requireString(stage.name, `stages[${index}].name`);
    if (!STAGE_NAMES.includes(stage.name)) throw new Error(`unknown stage ${stage.name}`);
    if (stagesByName.has(stage.name)) throw new Error(`duplicate stage ${stage.name}`);
    const stageStartedMs = timestamp(stage.startedAt, `${stage.name}.startedAt`);
    const stageCompletedMs = timestamp(stage.completedAt, `${stage.name}.completedAt`);
    if (stageCompletedMs < stageStartedMs) {
      throw new Error(`${stage.name}.completedAt must not precede startedAt`);
    }
    if (stageStartedMs < startedMs || stageCompletedMs > completedMs) {
      throw new Error(`${stage.name} must fall within the benchmark run`);
    }
    if (stageStartedMs < previousCompletedMs) throw new Error("stages must be ordered and non-overlapping");
    requireString(stage.outcome, `${stage.name}.outcome`);
    if (!STAGE_OUTCOMES[stage.name].has(stage.outcome)) {
      throw new Error(`${stage.name}.outcome is invalid`);
    }
    const durationMs = stageCompletedMs - stageStartedMs;
    if (requireDerived && stage.durationMs === undefined) {
      throw new Error(`${stage.name}.durationMs is required in a saved result`);
    }
    if (stage.durationMs !== undefined && stage.durationMs !== durationMs) {
      throw new Error(`${stage.name}.durationMs does not match its timestamps`);
    }
    stage.durationMs = durationMs;
    stagesByName.set(stage.name, stage);
    previousCompletedMs = stageCompletedMs;
  }
  if (!stagesByName.has(STAGE_NAMES[0])) throw new Error(`missing required stage ${STAGE_NAMES[0]}`);
  const resolutionStagePresent = stagesByName.has("resolve-provisional");
  if (task.resolutionAttempts > 0 && !resolutionStagePresent) {
    throw new Error("resolutionAttempts must agree with the resolve-provisional stage");
  }
  if (task.resolutionAttempts === 0 && resolutionStagePresent) {
    throw new Error("zero resolutionAttempts must omit the resolve-provisional stage");
  }

  if (!value.stages.every((stage, index) => stage.name === STAGE_NAMES[index])) {
    throw new Error("stages must use the documented workflow order");
  }

  const preparationOutcome = stagesByName.get("prepare-and-list-projects").outcome;
  const creationOutcome = stagesByName.get("create-thread")?.outcome;
  const recordingOutcome = stagesByName.get("record-task")?.outcome;
  const resolutionOutcome = stagesByName.get("resolve-provisional")?.outcome;
  if (preparationOutcome === "failed") {
    if (
      value.stages.length !== 1 || task.taskId !== null || task.threadId !== null || task.clientThreadId !== null ||
      task.recorded || task.resolution !== "unresolved" || task.resolutionAttempts !== 0
    ) throw new Error("failed preparation must stop the workflow unresolved");
  } else if (task.taskId === null || creationOutcome === undefined) {
    throw new Error("successful preparation requires a task ID and creation stage");
  }
  if (creationOutcome !== undefined && creationOutcome !== "failed" && recordingOutcome === undefined) {
    throw new Error("successful creation requires a record-task stage");
  }
  if (recordingOutcome !== undefined && (recordingOutcome === "recorded") !== task.recorded) {
    throw new Error("record-task outcome must agree with task.recorded");
  }
  if (creationOutcome === "durable") {
    if (task.resolution !== "immediate" || task.threadId === null || resolutionStagePresent) {
      throw new Error("durable creation must be an immediate durable resolution");
    }
  } else if (creationOutcome === "provisional") {
    if (task.clientThreadId === null) throw new Error("provisional creation requires a clientThreadId");
    if (task.recorded) {
      if (task.resolutionAttempts === 0) {
        if (resolutionStagePresent || task.resolution !== "unresolved" || task.threadId !== null) {
          throw new Error("zero-attempt provisional creation must remain unresolved");
        }
      } else if (
        !resolutionStagePresent ||
        (resolutionOutcome !== task.resolution && !(task.resolution === "unresolved" && resolutionOutcome === "failed"))
      ) {
        throw new Error("recorded provisional creation must agree with its resolution stage");
      }
      if ((task.resolution === "unresolved") !== (task.threadId === null)) {
        throw new Error("provisional resolution must agree with task.threadId");
      }
    } else if (
      resolutionStagePresent || task.resolution !== "unresolved" || task.threadId !== null || task.resolutionAttempts !== 0
    ) {
      throw new Error("unrecorded provisional creation must remain unresolved");
    }
  } else if (
    creationOutcome === "failed" && (
      value.stages.length !== 2 || task.resolution !== "unresolved" || task.threadId !== null ||
      task.clientThreadId !== null || task.recorded || resolutionStagePresent
    )
  ) {
    throw new Error("failed creation must remain unrecorded and unresolved");
  }

  const validation = requireObject(value.validation, "validation");
  const validationNames = [
    "recordVerified",
    "markerVerified",
    "outputVerified",
    "candidateFilterEffective",
  ];
  requireExactKeys(validation, validationNames, "validation");
  for (const name of validationNames) {
    if (typeof validation[name] !== "boolean") throw new Error(`validation.${name} must be boolean`);
  }
  if (validation.recordVerified && !task.recorded) throw new Error("recordVerified requires a recorded task");
  if (validation.markerVerified && task.threadId === null) throw new Error("markerVerified requires a durable threadId");
  if (validation.outputVerified && task.threadId === null) throw new Error("outputVerified requires a durable threadId");

  value.observations = normalizeObservations(
    value.observations,
    startedMs,
    completedMs,
    stagesByName.get("prepare-and-list-projects"),
    stagesByName.get("create-thread"),
    stagesByName.get("record-task"),
    stagesByName.get("resolve-provisional"),
    task.resolutionAttempts,
  );
  if (value.observations === undefined) delete value.observations;
  const snapshots = value.observations?.resolutionSnapshots ?? [];
  if (
    snapshots.length > 0 && snapshots.length !== task.resolutionAttempts &&
    !(resolutionOutcome === "failed" && snapshots.length === task.resolutionAttempts - 1)
  ) {
    throw new Error("resolutionSnapshots must account for every fallback attempt");
  }
  if (
    task.resolutionAttempts === 2 && snapshots.length !== 2 &&
    !(resolutionOutcome === "failed" && snapshots.length === 1)
  ) {
    throw new Error("two resolution attempts require two fallback snapshots");
  }
  if (task.resolution === "native" && (task.resolutionAttempts !== 1 || snapshots.length !== 0)) {
    throw new Error("native resolution requires exactly one non-snapshot attempt");
  }
  if (task.resolution === "discovered") {
    if (
      snapshots.length === 0 || snapshots.at(-1).exactMatchCount !== 1 ||
      snapshots.at(-1).resolveWriteOutcome !== "succeeded"
    ) {
      throw new Error("discovered resolution requires one successfully persisted final snapshot match");
    }
  }
  if (snapshots.some(
    (snapshot) => snapshot.attempt < task.resolutionAttempts && snapshot.exactMatchCount > 0,
  )) {
    throw new Error("any nonzero snapshot match count must terminate fallback resolution");
  }
  if (
    task.resolution === "unresolved" && snapshots.some(
      (snapshot) => snapshot.resolveWriteOutcome === "succeeded",
    )
  ) {
    throw new Error("unresolved resolution cannot have a successful resolve write");
  }
  if (
    snapshots.some((snapshot) => snapshot.resolveWriteOutcome === "failed") &&
    resolutionOutcome !== "failed"
  ) {
    throw new Error("a failed resolve write requires a failed resolution stage");
  }
  if (
    resolutionStagePresent && snapshots.length === 0 &&
    !["native", "unresolved"].includes(task.resolution)
  ) {
    throw new Error("non-snapshot resolution must be native or unresolved");
  }
  if (snapshots.length === 1 && snapshots[0].exactMatchCount === 0 && task.resolutionAttempts !== 2) {
    throw new Error("a completed first snapshot with zero matches requires the second fallback attempt");
  }
  const filterEffective = snapshots.length > 0 && snapshots.every(
    (snapshot) => snapshot.candidateCount < snapshot.recentTaskCount,
  );
  if (validation.candidateFilterEffective !== filterEffective) {
    throw new Error("candidateFilterEffective must match resolution snapshot counts");
  }

  const measuredStageMs = value.stages.reduce((total, stage) => total + stage.durationMs, 0);
  const totalWallMs = completedMs - startedMs;
  const summary = {
    totalWallMs,
    measuredStageMs,
    orchestrationOverheadMs: totalWallMs - measuredStageMs,
    resolved: task.threadId !== null,
    resolutionAttempts: task.resolutionAttempts,
  };
  if (requireDerived && value.summary === undefined) {
    throw new Error("summary is required in a saved result");
  }
  if (value.summary !== undefined) {
    const suppliedSummary = requireObject(value.summary, "summary");
    requireExactKeys(suppliedSummary, Object.keys(summary), "summary");
    if (Object.entries(summary).some(([name, expected]) => suppliedSummary[name] !== expected)) {
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
  const filename = `${timestampFilename(result.startedAt)}-${BENCHMARK_NAME}.json`;
  const outputPath = path.join(outputDirectory, filename);
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
  if (input.trim().length === 0) throw new Error("expected benchmark JSON on stdin");
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
