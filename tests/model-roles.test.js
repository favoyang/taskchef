import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { resolveModelRoles, updateModelRole } from '../src/model-roles.js';
import { initializeWorkspace, prepareDispatch, addProject } from '../src/workspace.js';
import { createDashboardServer } from '../src/dashboard.js';
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
  const { stdout } = await execFile('python3', [path.join(copy, 'resolve_roles.py'), '--codex-home', home, '--project', project], { cwd: root });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.roles[1].taskOverrides, { model: 'fixture-model', thinking: 'medium' });
  assert.deepEqual(result.roles[2].subagentOverrides, {});
  assert.equal(result.roles[2].status, 'missing');
  const preview = await resolveModelRoles(project, { env: { ...process.env, CODEX_HOME: home } });
  assert.deepEqual(preview.roles, result.roles.map((role) => ({ ...role, displaySource: role.source })));
});

test('resolver runtime failure is visible rather than reported honored', async () => {
  const { home } = await fixture();
  const result = await resolveModelRoles(null, { env: { ...process.env, CODEX_HOME: home }, run: async () => { throw new Error('missing runtime'); } });
  assert.equal(result.roles.length, 0);
  assert.match(result.problems[0], /not been honored/);
});

test('absent agent configuration preserves defaults without Python', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'roles-no-python-'));
  const result = await resolveModelRoles(root, { env: { ...process.env, CODEX_HOME: path.join(root, 'absent') }, run: async () => { throw new Error('must not run Python'); } });
  assert.deepEqual(result.problems, []);
  assert.equal(result.roles.length, 3);
  assert.ok(result.roles.every((role) => role.status === 'missing'));
  assert.deepEqual(result.roles[0].taskOverrides, {});
  assert.deepEqual(result.roles[2].subagentOverrides, {});
});

test('dispatch exposes project roles while settings stays personal-only', async () => {
  const { root, project } = await fixture();
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(project, '.codex/agents'), { recursive: true });
  await writeFile(path.join(project, '.codex/agents/planner.toml'), 'name="planner"\ndescription="Plan"\ndeveloper_instructions="Plan"\nmodel="deliberately-unavailable-fixture"\nmodel_reasoning_effort="medium"\n');
  await initializeWorkspace(workspace);
  await addProject(workspace, { name: 'Fixture', path: project });
  const preparation = await prepareDispatch(workspace);
  assert.equal(preparation.projectModelRoles[0].roles[0].model, 'deliberately-unavailable-fixture');
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
  assert.equal(result.roles[1].displaySource, '~/.codex/agents/implementer.toml');
  assert.equal(result.roles[1].model, 'gpt-fixture');
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
