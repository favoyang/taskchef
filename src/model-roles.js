import { execFile as execFileCallback } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const resolver = fileURLToPath(new URL('../scripts/roles/resolve_roles.py', import.meta.url));

async function hasAgentFiles(directory) {
  try { return (await readdir(directory)).some((name) => name.endsWith('.toml')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function missingRoles() {
  return {
    roles: ['orchestrator', 'planner', 'implementer', 'reviewer'].map((role) => ({
      role, source: null, effectiveSource: null, model: null, effort: null,
      status: 'missing', availability: 'No role files', problems: [],
      taskOverrides: {}, subagentOverrides: {},
      fallback: role === 'orchestrator' ? 'native new-task default' : 'inherit parent settings',
    })),
    problems: [], catalogSource: null, modelOptions: [],
    precedence: 'explicit user model (and its explicit effort) > personal role > native defaults; explicit effort alone overrides role effort',
    scope: 'Model and effort only; agent instructions, tools, permissions, and other TOML keys are not applied by this adapter.',
  };
}

export async function resolveModelRoles({ run = execFile, env = process.env, includeCatalog = false } = {}) {
  try {
    const home = env.HOME || os.homedir();
    const codexHome = (env.CODEX_HOME || path.join(home, '.codex')).replace(/^~(?=\/|$)/, home);
    const agentsDirectory = path.join(codexHome, 'agents');
    if (!await hasAgentFiles(agentsDirectory) && !includeCatalog) return missingRoles();
    const { stdout } = await run('python3', [resolver], {
      env, timeout: 5000, maxBuffer: 128 * 1024,
    });
    const result = JSON.parse(stdout);
    result.roles = result.roles.map((role) => ({
      ...role,
      displaySource: typeof role.source === 'string'
        ? `~/.codex/agents/${path.basename(role.source)}`
        : role.source,
    }));
    return result;
  } catch {
    return { roles: [], problems: ['Model role preview unavailable. Python 3.11+ and readable agent configuration are required when agent files exist; configured roles have not been honored.'], catalogSource: null };
  }
}

export async function updateModelRole(role, model, effort, { run = execFile, env = process.env } = {}) {
  const allowedRoles = new Set(['orchestrator', 'planner', 'implementer', 'reviewer']);
  if (!allowedRoles.has(role) || typeof model !== 'string' || typeof effort !== 'string') {
    const error = new Error('Invalid model role update.');
    error.code = 'invalid_request';
    throw error;
  }
  try {
    await run('python3', [resolver, '--update', '--role', role, '--model', model, '--effort', effort], {
      env, timeout: 5000, maxBuffer: 128 * 1024,
    });
    return resolveModelRoles({ run, env, includeCatalog: true });
  } catch (error) {
    if (error.code === 'invalid_request') throw error;
    const failure = new Error('Model role could not be saved.');
    failure.code = 'role_update_failed';
    throw failure;
  }
}
