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
    roles: ['planner', 'implementer', 'reviewer'].map((role) => ({
      role, source: null, effectiveSource: null, model: null, effort: null,
      status: 'missing', availability: 'No role files', problems: [],
      taskOverrides: {}, subagentOverrides: {},
      fallback: role === 'reviewer' ? 'inherit parent settings' : 'native new-task default (not guaranteed dispatcher inheritance)',
    })),
    problems: [], catalogSource: null,
    precedence: 'explicit user model (and its explicit effort) > project role > personal role > native defaults; explicit effort alone overrides role effort',
    scope: 'Model and effort only; agent instructions, tools, permissions, and other TOML keys are not applied by this adapter.',
  };
}

export async function resolveModelRoles(project = null, { run = execFile, env = process.env } = {}) {
  try {
    const home = env.HOME || os.homedir();
    const codexHome = (env.CODEX_HOME || path.join(home, '.codex')).replace(/^~(?=\/|$)/, home);
    const directories = [path.join(codexHome, 'agents'), ...(project ? [path.join(project, '.codex', 'agents')] : [])];
    const configured = await Promise.all(directories.map(hasAgentFiles));
    if (!configured.some(Boolean)) return missingRoles();
    const { stdout } = await run('python3', [resolver, ...(project ? ['--project', project] : [])], {
      env, timeout: 5000, maxBuffer: 128 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    return { roles: [], problems: ['Model role preview unavailable. Python 3.11+ and readable agent configuration are required when agent files exist; configured roles have not been honored.'], catalogSource: null };
  }
}
