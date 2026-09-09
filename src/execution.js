import { createHash } from "node:crypto";

export const EXECUTION_CONTRACT_VERSION = 1;
export const EXECUTION_MODES = new Set(["legacy", "orchestrated"]);
export const EXECUTION_INTENTS = new Set([
  "investigate",
  "plan_and_implement",
  "implement",
  "continue_plan",
]);
export const PHASE_KINDS = new Set(["plan", "implement", "review", "verify", "deliver"]);
export const EXECUTION_ROLES = new Set(["orchestrator", "planner", "implementer", "reviewer"]);
export const PHASE_STATES = new Set([
  "reserved",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "interrupted",
]);
export const ACTIVE_PHASE_STATES = new Set(["reserved", "running"]);

const RESOLUTION_STATUSES = new Set(["configured", "missing"]);
const BINDING_PROVENANCE = new Set(["native", "child_asserted"]);
const FINISH_STATES = new Set(["awaiting_input", "completed", "failed", "interrupted"]);
const MAX_PHASES_PER_TURN = 64;
const MAX_EVENTS_PER_PHASE = 8;
const MAX_ARTIFACTS = 32;

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function exact(value, fields, name) {
  object(value, name);
  const unexpected = Object.keys(value).find((key) => !fields.has(key));
  if (unexpected) throw new Error(`${name} has unsupported field: ${unexpected}`);
  const missing = [...fields].find((key) => !(key in value));
  if (missing) throw new Error(`${name} is missing field: ${missing}`);
  return value;
}

function string(value, name, max = 256) {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function nullableString(value, name, max = 256) {
  return value === null ? null : string(value, name, max);
}

function timestamp(value, name) {
  const normalized = string(value, name, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(normalized) || Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${name} must be an ISO 8601 timestamp`);
  }
  return normalized;
}

function enumeration(value, values, name) {
  if (!values.has(value)) throw new Error(`${name} must be one of: ${[...values].join(", ")}`);
  return value;
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error(`${name} must be an integer from 1 through 100`);
  }
  return value;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function eventHash(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function normalizeExecutionResolution(value, name = "resolution") {
  exact(value, new Set([
    "requestedModel", "requestedEffort", "source", "status", "resolvedAt",
    "model", "effort", "effectiveModel", "effectiveEffort",
  ]), name);
  const status = enumeration(value.status, RESOLUTION_STATUSES, `${name}.status`);
  const normalized = {
    requestedModel: nullableString(value.requestedModel, `${name}.requestedModel`),
    requestedEffort: nullableString(value.requestedEffort, `${name}.requestedEffort`, 32),
    source: nullableString(value.source, `${name}.source`, 512),
    status,
    resolvedAt: timestamp(value.resolvedAt, `${name}.resolvedAt`),
    model: nullableString(value.model, `${name}.model`),
    effort: nullableString(value.effort, `${name}.effort`, 32),
    effectiveModel: nullableString(value.effectiveModel, `${name}.effectiveModel`),
    effectiveEffort: nullableString(value.effectiveEffort, `${name}.effectiveEffort`, 32),
  };
  if (status === "missing" && (normalized.model !== null || normalized.effort !== null)) {
    throw new Error(`${name} cannot contain model or effort when status is missing`);
  }
  if (normalized.effectiveEffort !== null && normalized.effectiveModel === null) {
    throw new Error(`${name}.effectiveEffort requires effectiveModel evidence`);
  }
  return normalized;
}

export function resolutionSnapshotFromRole(role, {
  requestedModel = null,
  requestedEffort = null,
  resolvedAt = new Date().toISOString(),
  effectiveModel = null,
  effectiveEffort = null,
} = {}) {
  object(role, "role resolution");
  const status = enumeration(role.status, new Set(["configured", "missing"]), "role resolution.status");
  return normalizeExecutionResolution({
    requestedModel,
    requestedEffort,
    source: typeof role.effectiveSource === "string" ? role.effectiveSource : null,
    status,
    resolvedAt,
    model: typeof role.model === "string" ? role.model : null,
    effort: typeof role.effort === "string" ? role.effort : null,
    effectiveModel,
    effectiveEffort,
  });
}

export function normalizePlanReference(value, name = "planRef") {
  if (value === null) return null;
  exact(value, new Set(["repository", "path", "revision", "contentHash"]), name);
  const plan = {
    repository: string(value.repository, `${name}.repository`, 512),
    path: string(value.path, `${name}.path`, 512),
    revision: string(value.revision, `${name}.revision`, 256),
    contentHash: string(value.contentHash, `${name}.contentHash`, 128),
  };
  if (plan.path.startsWith("/") || plan.path.split("/").includes("..")) {
    throw new Error(`${name}.path must be repository-relative`);
  }
  return plan;
}

function normalizeThreadBinding(value, name) {
  if (value === null) return null;
  exact(value, new Set(["threadId", "provenance"]), name);
  return {
    threadId: string(value.threadId, `${name}.threadId`),
    provenance: enumeration(value.provenance, BINDING_PROVENANCE, `${name}.provenance`),
  };
}

function normalizePhaseResult(value, name) {
  if (value === null) return null;
  exact(value, new Set(["summary", "artifacts"]), name);
  if (!Array.isArray(value.artifacts) || value.artifacts.length > MAX_ARTIFACTS) {
    throw new Error(`${name}.artifacts must contain at most ${MAX_ARTIFACTS} entries`);
  }
  return {
    summary: string(value.summary, `${name}.summary`, 2_000),
    artifacts: value.artifacts.map((artifact, index) => string(
      artifact,
      `${name}.artifacts[${index}]`,
      1_000,
    )),
  };
}

function normalizePhaseEventRecord(value, name) {
  exact(value, new Set(["eventId", "operation", "payloadHash", "at"]), name);
  return {
    eventId: string(value.eventId, `${name}.eventId`),
    operation: enumeration(value.operation, new Set(["reserve", "start", "bind", "finish"]), `${name}.operation`),
    payloadHash: string(value.payloadHash, `${name}.payloadHash`, 64),
    at: timestamp(value.at, `${name}.at`),
  };
}

export function normalizePhase(value, name = "phase") {
  exact(value, new Set([
    "phaseId", "kind", "attempt", "role", "resolution", "agentHandle",
    "threadBinding", "writer", "writerGeneration", "state", "startedAt",
    "endedAt", "result", "reviewPassId", "events",
  ]), name);
  if (typeof value.writer !== "boolean") throw new Error(`${name}.writer must be a boolean`);
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > MAX_EVENTS_PER_PHASE) {
    throw new Error(`${name}.events must contain 1 through ${MAX_EVENTS_PER_PHASE} events`);
  }
  const phase = {
    phaseId: string(value.phaseId, `${name}.phaseId`),
    kind: enumeration(value.kind, PHASE_KINDS, `${name}.kind`),
    attempt: positiveInteger(value.attempt, `${name}.attempt`),
    role: enumeration(value.role, EXECUTION_ROLES, `${name}.role`),
    resolution: normalizeExecutionResolution(value.resolution, `${name}.resolution`),
    agentHandle: nullableString(value.agentHandle, `${name}.agentHandle`, 512),
    threadBinding: normalizeThreadBinding(value.threadBinding, `${name}.threadBinding`),
    writer: value.writer,
    writerGeneration: value.writerGeneration === null
      ? null
      : positiveSafeInteger(value.writerGeneration, `${name}.writerGeneration`),
    state: enumeration(value.state, PHASE_STATES, `${name}.state`),
    startedAt: timestamp(value.startedAt, `${name}.startedAt`),
    endedAt: value.endedAt === null ? null : timestamp(value.endedAt, `${name}.endedAt`),
    result: normalizePhaseResult(value.result, `${name}.result`),
    reviewPassId: nullableString(value.reviewPassId, `${name}.reviewPassId`),
    events: value.events.map((event, index) => normalizePhaseEventRecord(event, `${name}.events[${index}]`)),
  };
  if (phase.kind === "review" && (phase.role !== "reviewer" || phase.writer)) {
    throw new Error(`${name} review phases must use a read-only reviewer`);
  }
  if (phase.writer !== (phase.writerGeneration !== null)) {
    throw new Error(`${name}.writerGeneration must be present exactly when writer is true`);
  }
  if (ACTIVE_PHASE_STATES.has(phase.state)) {
    if (phase.endedAt !== null || phase.result !== null) throw new Error(`${name} active phase cannot have a result`);
  } else if (phase.endedAt === null || phase.result === null) {
    throw new Error(`${name} terminal phase requires endedAt and result`);
  }
  if (phase.state === "reserved" && phase.agentHandle !== null) {
    throw new Error(`${name} reserved phase cannot have an agent handle`);
  }
  const started = phase.events.some((event) => event.operation === "start");
  const interruptedBeforeStart = phase.state === "interrupted" && !started;
  if (
    phase.state !== "reserved"
    && phase.state !== "failed"
    && !interruptedBeforeStart
    && phase.agentHandle === null
  ) {
    throw new Error(`${name} phase requires an agent handle after start`);
  }
  const ids = phase.events.map((event) => event.eventId);
  if (new Set(ids).size !== ids.length) throw new Error(`${name} has duplicate event IDs`);
  return phase;
}

export function normalizeExecutionTurn(value, name = "turn") {
  const intent = value.intent === null ? null : enumeration(value.intent, EXECUTION_INTENTS, `${name}.intent`);
  const acceptedScope = nullableString(value.acceptedScope, `${name}.acceptedScope`, 2_000);
  if ((intent === null) !== (acceptedScope === null)) {
    throw new Error(`${name}.intent and acceptedScope must be present together`);
  }
  if (!Array.isArray(value.phases) || value.phases.length > MAX_PHASES_PER_TURN) {
    throw new Error(`${name}.phases must contain at most ${MAX_PHASES_PER_TURN} entries`);
  }
  const phases = value.phases.map((phase, index) => normalizePhase(phase, `${name}.phases[${index}]`));
  const phaseIds = phases.map((phase) => phase.phaseId);
  if (new Set(phaseIds).size !== phaseIds.length) throw new Error(`${name} has duplicate phase IDs`);
  const active = phases.filter((phase) => ACTIVE_PHASE_STATES.has(phase.state));
  if (active.length > 1) throw new Error(`${name} has concurrent active phases`);
  const writerGenerations = phases.flatMap((phase) => phase.writerGeneration === null ? [] : [phase.writerGeneration]);
  if (new Set(writerGenerations).size !== writerGenerations.length) {
    throw new Error(`${name} has duplicate writer generations`);
  }
  const reviewPasses = phases.flatMap((phase) => phase.reviewPassId === null ? [] : [phase.reviewPassId]);
  if (new Set(reviewPasses).size !== reviewPasses.length) throw new Error(`${name} has duplicate review pass IDs`);
  return {
    intent,
    acceptedScope,
    planRef: normalizePlanReference(value.planRef, `${name}.planRef`),
    phases,
  };
}

export function normalizeExecutionTask(value, name = "task") {
  const executionMode = enumeration(value.executionMode, EXECUTION_MODES, `${name}.executionMode`);
  const executionRevision = nonnegativeInteger(value.executionRevision, `${name}.executionRevision`);
  const parentResolution = value.parentResolution === null
    ? null
    : normalizeExecutionResolution(value.parentResolution, `${name}.parentResolution`);
  if (executionMode === "orchestrated" && parentResolution === null) {
    throw new Error(`${name}.parentResolution is required in orchestrated mode`);
  }
  return { executionMode, executionRevision, parentResolution };
}

export function legacyExecutionTurn(turn) {
  return { ...turn, intent: null, acceptedScope: null, planRef: null, phases: [] };
}

export function activeExecutionPhase(task) {
  return task.turns.flatMap((turn) => turn.phases ?? [])
    .find((phase) => ACTIVE_PHASE_STATES.has(phase.state)) ?? null;
}

export function interruptExecutionPhases(turn, at, summary = "Phase interrupted by a newer lifecycle turn.") {
  let changed = false;
  const phases = (turn.phases ?? []).map((phase) => {
    if (!ACTIVE_PHASE_STATES.has(phase.state)) return phase;
    changed = true;
    return {
      ...phase,
      state: "interrupted",
      endedAt: at,
      result: { summary, artifacts: [] },
    };
  });
  return { turn: { ...turn, phases }, changed };
}

export function assertOrchestratedCompletion(task) {
  if (task.executionMode !== "orchestrated") return;
  const turn = task.latestTurn;
  if (!turn || turn.intent === null) throw new Error("orchestrated completion requires a classified lifecycle turn");
  if (activeExecutionPhase(task)) throw new Error("orchestrated completion requires every phase to be terminal");
  const required = turn.intent === "investigate"
    ? ["plan"]
    : turn.intent === "plan_and_implement"
      ? ["plan", "implement", "review"]
      : ["implement", "review"];
  const phases = turn.phases ?? [];
  const lastWriterIndex = phases.findLastIndex((phase) => phase.writer);
  const missing = required.filter((kind) => {
    if (kind === "review") {
      const reviews = phases.slice(lastWriterIndex + 1).filter((phase) => phase.kind === "review");
      return reviews.length === 0 || reviews.at(-1).state !== "completed";
    }
    const attempts = phases.filter((phase) => phase.kind === kind);
    return attempts.length === 0 || attempts.at(-1).state !== "completed";
  });
  if (missing.length > 0) throw new Error(`orchestrated completion is missing completed phases: ${missing.join(", ")}`);
}

const PHASE_INPUT_FIELDS = new Set([
  "taskId", "parentThreadId", "turnRef", "eventId", "expectedRevision",
  "operation", "phaseId", "kind", "attempt", "role", "resolution", "writer",
  "agentHandle", "threadId", "bindingProvenance", "state", "summary", "artifacts",
  "reviewPassId",
]);

function normalizePhaseEventInput(input) {
  object(input, "phase event");
  const unexpected = Object.keys(input).find((key) => !PHASE_INPUT_FIELDS.has(key));
  if (unexpected) throw new Error(`phase event has unsupported field: ${unexpected}`);
  for (const field of ["taskId", "parentThreadId", "turnRef", "eventId", "expectedRevision", "operation", "phaseId"]) {
    if (!(field in input)) throw new Error(`phase event is missing field: ${field}`);
  }
  const operation = enumeration(input.operation, new Set(["reserve", "start", "bind", "finish"]), "phase event.operation");
  const normalized = {
    taskId: string(input.taskId, "phase event.taskId"),
    parentThreadId: string(input.parentThreadId, "phase event.parentThreadId"),
    turnRef: string(input.turnRef, "phase event.turnRef"),
    eventId: string(input.eventId, "phase event.eventId"),
    expectedRevision: nonnegativeInteger(input.expectedRevision, "phase event.expectedRevision"),
    operation,
    phaseId: string(input.phaseId, "phase event.phaseId"),
  };
  if (operation === "reserve") {
    for (const field of ["kind", "attempt", "role", "resolution", "writer"]) {
      if (!(field in input)) throw new Error(`reserve phase event is missing field: ${field}`);
    }
    if (typeof input.writer !== "boolean") throw new Error("phase event.writer must be a boolean");
    Object.assign(normalized, {
      kind: enumeration(input.kind, PHASE_KINDS, "phase event.kind"),
      attempt: positiveInteger(input.attempt, "phase event.attempt"),
      role: enumeration(input.role, EXECUTION_ROLES, "phase event.role"),
      resolution: normalizeExecutionResolution(input.resolution, "phase event.resolution"),
      writer: input.writer,
      reviewPassId: "reviewPassId" in input
        ? nullableString(input.reviewPassId, "phase event.reviewPassId")
        : null,
    });
  } else if (operation === "start") {
    normalized.agentHandle = string(input.agentHandle, "phase event.agentHandle", 512);
  } else if (operation === "bind") {
    normalized.threadId = string(input.threadId, "phase event.threadId");
    normalized.bindingProvenance = enumeration(input.bindingProvenance, BINDING_PROVENANCE, "phase event.bindingProvenance");
  } else {
    normalized.state = enumeration(input.state, FINISH_STATES, "phase event.state");
    normalized.summary = string(input.summary, "phase event.summary", 2_000);
    if (!Array.isArray(input.artifacts) || input.artifacts.length > MAX_ARTIFACTS) {
      throw new Error(`phase event.artifacts must contain at most ${MAX_ARTIFACTS} entries`);
    }
    normalized.artifacts = input.artifacts.map((artifact, index) => string(
      artifact,
      `phase event.artifacts[${index}]`,
      1_000,
    ));
  }
  return normalized;
}

export function applyPhaseEvent(task, rawInput, { now = () => new Date().toISOString() } = {}) {
  const input = normalizePhaseEventInput(rawInput);
  if (task.executionMode !== "orchestrated") throw new Error("phase events require orchestrated execution mode");
  if (task.id !== input.taskId) throw new Error("phase event taskId does not match task");
  if (task.threadId !== input.parentThreadId) throw new Error("phase event parentThreadId does not match task parent");
  if (task.status !== "working" || task.turnRef !== input.turnRef || task.latestTurn?.result !== null) {
    throw new Error("phase event must target the current working lifecycle turn");
  }
  const allEvents = task.turns.flatMap((turn) => (turn.phases ?? []).flatMap((phase) => (
    phase.events.map((event) => ({ phase, event }))
  )));
  const hash = eventHash(input);
  const priorEvent = allEvents.find(({ event }) => event.eventId === input.eventId);
  if (priorEvent) {
    if (priorEvent.event.payloadHash !== hash || priorEvent.phase.phaseId !== input.phaseId) {
      throw new Error(`phase eventId is already used with different content: ${input.eventId}`);
    }
    return { task, phase: priorEvent.phase, idempotent: true };
  }
  if (task.executionRevision !== input.expectedRevision) {
    throw new Error(`phase event expected revision ${input.expectedRevision} but current revision is ${task.executionRevision}`);
  }
  const at = timestamp(now(), "phase event timestamp");
  const turnIndex = task.turns.length - 1;
  const turn = task.turns[turnIndex];
  const phases = [...(turn.phases ?? [])];
  let phaseIndex = phases.findIndex((phase) => phase.phaseId === input.phaseId);
  const event = { eventId: input.eventId, operation: input.operation, payloadHash: hash, at };
  if (input.operation === "reserve") {
    if (phaseIndex !== -1) throw new Error(`phase already exists: ${input.phaseId}`);
    if (phases.length >= MAX_PHASES_PER_TURN) throw new Error("lifecycle turn reached its phase limit");
    if (phases.some((phase) => ACTIVE_PHASE_STATES.has(phase.state))) {
      throw new Error("another phase is already active");
    }
    if (phases.some((phase) => phase.kind === input.kind && phase.attempt === input.attempt)) {
      throw new Error(`phase attempt already exists for ${input.kind} attempt ${input.attempt}`);
    }
    if (input.kind === "review" && (input.role !== "reviewer" || input.writer)) {
      throw new Error("review phases must reserve a read-only reviewer");
    }
    if (input.reviewPassId !== null && input.kind !== "review") {
      throw new Error("reviewPassId is accepted only for review phases");
    }
    phases.push(normalizePhase({
      phaseId: input.phaseId,
      kind: input.kind,
      attempt: input.attempt,
      role: input.role,
      resolution: input.resolution,
      agentHandle: null,
      threadBinding: null,
      writer: input.writer,
      writerGeneration: input.writer ? task.executionRevision + 1 : null,
      state: "reserved",
      startedAt: at,
      endedAt: null,
      result: null,
      reviewPassId: input.reviewPassId,
      events: [event],
    }));
    phaseIndex = phases.length - 1;
  } else {
    if (phaseIndex === -1) throw new Error(`phase not found: ${input.phaseId}`);
    const phase = phases[phaseIndex];
    if (phase.events.length >= MAX_EVENTS_PER_PHASE) throw new Error("phase reached its event limit");
    if (input.operation === "start") {
      if (phase.state !== "reserved") throw new Error("only a reserved phase can start");
      phases[phaseIndex] = normalizePhase({
        ...phase,
        state: "running",
        agentHandle: input.agentHandle,
        events: [...phase.events, event],
      });
    } else if (input.operation === "bind") {
      if (phase.state !== "running") throw new Error("only a running phase can bind a child identity");
      if (phase.threadBinding !== null) throw new Error("phase already has a child identity binding");
      const reused = task.turns.flatMap((candidate) => candidate.phases ?? [])
        .find((candidate) => candidate.threadBinding?.threadId === input.threadId);
      if (reused) throw new Error("child thread identity is already bound to this task");
      phases[phaseIndex] = normalizePhase({
        ...phase,
        threadBinding: { threadId: input.threadId, provenance: input.bindingProvenance },
        events: [...phase.events, event],
      });
    } else {
      if (!ACTIVE_PHASE_STATES.has(phase.state)) throw new Error("only an active phase can finish");
      if (phase.state === "reserved" && !["failed", "interrupted"].includes(input.state)) {
        throw new Error("a phase that never started can finish only as failed or interrupted");
      }
      phases[phaseIndex] = normalizePhase({
        ...phase,
        state: input.state,
        endedAt: at,
        result: { summary: input.summary, artifacts: input.artifacts },
        events: [...phase.events, event],
      });
    }
  }
  const turns = task.turns.map((candidate, index) => index === turnIndex
    ? { ...candidate, phases }
    : candidate);
  return {
    task: { ...task, executionRevision: task.executionRevision + 1, turns },
    phase: phases[phaseIndex],
    idempotent: false,
  };
}
