import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { resolveExecutionRole, resolveModelRoles, updateModelRole } from '../src/model-roles.js';
import {
  addProject,
  initializeWorkspace,
  linkTask,
  prepareDispatch,
  recordTask,
  reportTaskPhase,
  reportTaskState,
} from '../src/workspace.js';
import { createDashboardServer } from '../src/dashboard.js';
import { prepareDelegation } from '../src/delegation.js';
import { resolutionSnapshotFromRole } from '../src/execution.js';
const execFile = promisify(callback);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'roles-'));
  const home = path.join(root, 'codex');
  const project = path.join(root, 'project');
  await mkdir(path.join(home, 'agents'), { recursive: true });
  await mkdir(project);
  const profile = 'name="implementer"\ndescription="Code"\ndeveloper_instructions="Implement"\nmodel="fixture-model"\nmodel_reasoning_effort="medium"\n';
  await writeFile(path.join(home, 'agents/implementer.toml'), profile);
  return { root, home, project };
}

test('packaged resolver runs outside a checkout with profile/fallback behavior', async () => {
  const { root, home, project } = await fixture();
  const copy = path.join(root, 'package');
  await cp(new URL('../scripts/roles', import.meta.url), copy, { recursive: true });
  const { stdout } = await execFile('python3', [path.join(copy, 'resolve_roles.py'), '--codex-home', home], { cwd: root });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.roles[2].taskOverrides, { model: 'fixture-model', thinking: 'medium' });
  assert.deepEqual(result.roles[3].subagentOverrides, {});
  assert.equal(result.roles[3].status, 'missing');
  const preview = await resolveModelRoles({ env: { ...process.env, CODEX_HOME: home } });
  assert.deepEqual(preview.roles, result.roles.map((role) => ({
    ...role,
    displaySource: role.source ? `~/.codex/agents/${path.basename(role.source)}` : role.source,
  })));
  await assert.rejects(
    execFile('python3', [path.join(copy, 'resolve_roles.py'), '--codex-home', home, '--project', project], { cwd: root }),
    /unrecognized arguments: --project/,
  );
});

test('resolver runtime failure is visible rather than reported honored', async () => {
  const { home } = await fixture();
  const result = await resolveModelRoles({ env: { ...process.env, CODEX_HOME: home }, run: async () => { throw new Error('missing runtime'); } });
  assert.equal(result.roles.length, 0);
  assert.match(result.problems[0], /not been honored/);
});

test('absent agent configuration preserves defaults without Python', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'roles-no-python-'));
  const result = await resolveModelRoles({ env: { ...process.env, CODEX_HOME: path.join(root, 'absent') }, run: async () => { throw new Error('must not run Python'); } });
  assert.deepEqual(result.problems, []);
  assert.equal(result.roles.length, 4);
  assert.ok(result.roles.every((role) => role.status === 'missing'));
  assert.deepEqual(result.roles[0].taskOverrides, {});
  assert.deepEqual(result.roles[3].subagentOverrides, {});
});

test('dispatch and settings expose personal roles only', async () => {
  const { root, project } = await fixture();
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(project, '.codex/agents'), { recursive: true });
  await writeFile(path.join(project, '.codex/agents/planner.toml'), 'name="planner"\ndescription="Plan"\ndeveloper_instructions="Plan"\nmodel="deliberately-unavailable-fixture"\nmodel_reasoning_effort="medium"\n');
  await initializeWorkspace(workspace);
  await addProject(workspace, { name: 'Fixture', path: project });
  const preparation = await prepareDispatch(workspace);
  assert.ok(preparation.modelRoles);
  assert.equal('projectModelRoles' in preparation, false);
  const server = await createDashboardServer({ workspace, port: 0 });
  try {
    const response = await fetch(`${server.url}api/settings`);
    assert.equal(response.status, 200);
    const settings = await response.json();
    assert.equal(settings.profiles.length, 1);
    assert.equal(settings.profiles[0].project, 'Personal');
  } finally { await server.close(); }
});

test('updates only personal model preferences and preserves the rest of native TOML', async () => {
  const { home } = await fixture();
  await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{
    slug: 'gpt-fixture', display_name: 'GPT Fixture',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
  }] }));
  const target = path.join(home, 'agents/implementer.toml');
  await writeFile(target, 'name="implementer"\ndescription="Code"\ndeveloper_instructions="Keep this"\nmodel="old"\nmodel_reasoning_effort="medium"\n\n[tools]\nmodel="nested-preserved"\n');
  const result = await updateModelRole('implementer', 'gpt-fixture', 'high', { env: { ...process.env, CODEX_HOME: home } });
  const content = await readFile(target, 'utf8');
  assert.match(content, /developer_instructions="Keep this"/);
  assert.match(content, /model="gpt-fixture"/);
  assert.match(content, /model_reasoning_effort="high"/);
  assert.match(content, /\[tools\]\nmodel="nested-preserved"/);
  assert.equal(result.roles[2].displaySource, '~/.codex/agents/implementer.toml');
  assert.equal(result.roles[2].model, 'gpt-fixture');
});

test('role-specific resolution reads only the requested role outcome and supports orchestrator', async () => {
  const { home } = await fixture();
  await writeFile(
    path.join(home, 'agents/custom-parent.toml'),
    'name="orchestrator"\ndescription="Coordinate"\ndeveloper_instructions="Coordinate only"\nmodel="parent-model"\nmodel_reasoning_effort="high"\n',
  );
  await writeFile(
    path.join(home, 'agents/planner.toml'),
    'name="planner"\ndescription="Plan"\ndeveloper_instructions="Plan only"\nmodel="planner-model"\nmodel_reasoning_effort="medium"\n',
  );
  const orchestrator = await resolveExecutionRole('orchestrator', {
    env: { ...process.env, CODEX_HOME: home },
  });
  assert.equal(orchestrator.role, 'orchestrator');
  assert.equal(orchestrator.model, 'parent-model');
  assert.equal(orchestrator.displaySource, '~/.codex/agents/custom-parent.toml');
  const planner = await resolveExecutionRole('planner', {
    explicitModel: 'explicit-model',
    env: { ...process.env, CODEX_HOME: home },
  });
  assert.deepEqual(planner.subagentOverrides, { model: 'explicit-model' });
  assert.equal(planner.effort, null);
});

test('role-specific resolution makes structurally ambiguous TOML visible without blaming unrelated valid roles', async () => {
  const { home } = await fixture();
  await writeFile(
    path.join(home, 'agents/planner.toml'),
    'name="planner"\ndescription="Plan"\ndeveloper_instructions="Plan only"\nmodel="planner-model"\nmodel_reasoning_effort="medium"\n',
  );
  const clean = await resolveExecutionRole('planner', { env: { ...process.env, CODEX_HOME: home } });
  assert.equal(clean.status, 'configured');
  await writeFile(path.join(home, 'agents/unidentified.toml'), 'name = [broken');
  const unresolved = await resolveExecutionRole('planner', { env: { ...process.env, CODEX_HOME: home } });
  assert.equal(unresolved.status, 'invalid');
  assert.deepEqual(unresolved.subagentOverrides, {});
  assert.match(unresolved.problems.join(' '), /unreadable or malformed/);
});

test('role-specific resolution keeps a malformed model catalog advisory', async () => {
  const { home } = await fixture();
  await writeFile(path.join(home, 'models_cache.json'), '{malformed');
  const resolved = await resolveExecutionRole('orchestrator', {
    env: { ...process.env, CODEX_HOME: home },
  });
  assert.equal(resolved.status, 'missing');
  assert.deepEqual(resolved.taskOverrides, {});
  assert.match(resolved.advisories.join(' '), /catalog is unreadable or malformed/);
});

test('current native availability can override only a stale catalog warning', async () => {
  const { home, project, root } = await fixture();
  await writeFile(
    path.join(home, 'agents/orchestrator.toml'),
    'name="orchestrator"\ndescription="Coordinate"\ndeveloper_instructions="Coordinate only"\nmodel="current-native-model"\nmodel_reasoning_effort="high"\n',
  );
  await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: [] }));

  const stale = await resolveExecutionRole('orchestrator', {
    env: { ...process.env, CODEX_HOME: home },
  });
  assert.equal(stale.status, 'unavailable');
  assert.deepEqual(stale.taskOverrides, {});

  const confirmed = await resolveExecutionRole('orchestrator', {
    env: { ...process.env, CODEX_HOME: home },
    nativeAvailabilityConfirmed: true,
  });
  assert.equal(confirmed.status, 'configured');
  assert.equal(confirmed.availability, 'confirmed by the current native interface');
  assert.deepEqual(confirmed.taskOverrides, { model: 'current-native-model', thinking: 'high' });
  assert.match(confirmed.advisories.join(' '), /absent from local Codex catalog/);

  const workspace = path.join(root, 'workspace');
  const taskId = '11111111-1111-4111-8111-111111111111';
  const parentThreadId = '018f2a01-0000-7000-8000-000000000001';
  const turnRef = '018f2a01-0000-7000-8000-000000000002';
  await initializeWorkspace(workspace);
  await addProject(workspace, { name: 'Project', path: project });
  const prepared = prepareDelegation('Use the confirmed role.', { taskId });
  await recordTask(workspace, {
    id: taskId,
    project,
    title: 'Confirmed stale catalog',
    instruction: prepared.instruction,
    threadId: null,
    executionMode: 'orchestrated',
    executionContractVersion: 1,
    parentResolution: resolutionSnapshotFromRole(confirmed),
  });
  await linkTask(workspace, taskId, parentThreadId);
  await reportTaskState(workspace, {
    taskId,
    threadId: parentThreadId,
    turnRef,
    turnId: turnRef,
    status: 'working',
    summary: null,
    requestSummary: 'Implement the confirmed role fixture.',
    intent: 'implement',
    acceptedScope: 'Change only the fixture.',
    planRef: null,
  });
  const implementer = await resolveExecutionRole('implementer', {
    env: { ...process.env, CODEX_HOME: home },
    nativeAvailabilityConfirmed: true,
  });
  const reserved = await reportTaskPhase(workspace, {
    taskId,
    parentThreadId,
    turnRef,
    eventId: '21111111-1111-4111-8111-111111111111',
    expectedRevision: 0,
    operation: 'reserve',
    phaseId: 'implement-1',
    kind: 'implement',
    attempt: 1,
    role: 'implementer',
    resolution: resolutionSnapshotFromRole(implementer),
    writer: true,
    reviewPassId: null,
  });
  assert.equal(reserved.phase.resolution.model, 'fixture-model');
});

test('role updates preserve multiline instructions containing TOML-like examples', async () => {
  const { home } = await fixture();
  await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{
    slug: 'gpt-fixture', display_name: 'GPT Fixture',
    supported_reasoning_levels: [{ effort: 'high' }],
  }] }));
  const target = path.join(home, 'agents/implementer.toml');
  await writeFile(target, `name = "implementer"\ndescription = "Code"\ndeveloper_instructions = """Keep this example:\nmodel = "example"\n[tools]\nenabled = true\n"""\nmodel = "old"\nmodel_reasoning_effort = "medium"\n\n[tools]\nmode = "preserved"\n`);
  await updateModelRole('implementer', 'gpt-fixture', 'high', { env: { ...process.env, CODEX_HOME: home } });
  const content = await readFile(target, 'utf8');
  assert.match(content, /developer_instructions = """Keep this example:\nmodel = "example"\n\[tools\]\nenabled = true\n"""/);
  assert.match(content, /\nmodel = "gpt-fixture"\nmodel_reasoning_effort = "high"\n/);
  assert.match(content, /\[tools\]\nmode = "preserved"/);
});

test('settings update requires same origin and returns the refreshed personal profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'roles-api-'));
  const workspace = path.join(root, 'workspace');
  await initializeWorkspace(workspace);
  const profile = { roles: [], problems: [], modelOptions: [] };
  const calls = [];
  const server = await createDashboardServer({
    workspace, port: 0,
    resolveRoles: async () => profile,
    updateRole: async (...args) => { calls.push(args); return profile; },
  });
  try {
    const blocked = await fetch(`${server.url}api/settings/planner`, {
      method: 'POST', headers: { Origin: 'http://example.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, model: 'gpt-fixture', effort: 'low' }),
    });
    assert.equal(blocked.status, 403);
    const saved = await fetch(`${server.url}api/settings/planner`, {
      method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, model: 'gpt-fixture', effort: 'low' }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(calls, [['planner', 'gpt-fixture', 'low']]);
    assert.equal((await saved.json()).profile.id, 'personal');
  } finally { await server.close(); }
});
