import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as taskchef from "../index.js";

import {
  addProject,
  buildTaskSummary,
  canonicalDirectory,
  doctorWorkspace,
  ensureWorkspaceInstructions,
  ensureWorkspaceSkills,
  filterTasks,
  importProjects,
  initializeWorkspace,
  listProjects,
  readConfig,
  listTasks,
  readTask,
  recordTask,
  removeProject,
  requireSafeId,
  validateConfig,
} from "../index.js";
import {
  pinTaskChefNpmSource,
  installPublishedPluginDependencies,
  preserveSharedMarketplaceFile,
  resolveExpectedPublishedPlugin,
  updateSharedMarketplaceFile,
  validateExtractedPlugin,
  validatePublishedPluginPackage,
  validateSkillFrontmatter,
} from "../scripts/update-shared-marketplace.js";

const execFile = promisify(execFileCallback);
const FIXED_TIME = "2026-08-08T10:00:00.000Z";
const LATER_TIME = "2026-08-08T10:05:00.000Z";

async function gitProject(parent, name, remote = null) {
  const project = path.join(parent, name);
  await mkdir(project, { recursive: true });
  await execFile("git", ["init", "-q"], { cwd: project });
  if (remote) await execFile("git", ["remote", "add", "origin", remote], { cwd: project });
  return realpath(project);
}

async function fixture(projectCount = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-v2-"));
  const workspace = path.join(root, "dispatcher");
  await initializeWorkspace(workspace);
  const projects = [];
  for (let index = 0; index < projectCount; index += 1) {
    const project = await gitProject(
      root,
      `project-${index + 1}`,
      `git@github.com:example/project-${index + 1}.git`,
    );
    projects.push(project);
    await addProject(workspace, {
      name: `project-${index + 1}`,
      path: project,
      description: `Fixture project ${index + 1}.`,
    });
  }
  return { root, workspace, projects };
}

function dispatchInput(project, id = "dispatch-1", threadId = `thread-${id}`) {
  return {
    id,
    project,
    title: "Echo input",
    instruction: "Create echo_input.py, test it, and report the result.",
    threadId,
  };
}

async function runCli(args, { input = "", cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(
      process.execPath,
      [path.resolve("bin/taskchef.js"), ...args],
      { cwd: cwd ?? process.cwd() },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    child.stdin.end(input);
  });
}

test("lightweight init creates a data-only workspace scaffold", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-init-"));
  const workspace = path.join(root, "workspace");
  const initialized = await initializeWorkspace(workspace);

  assert.deepEqual(initialized.config.value, { schemaVersion: 1, projects: [] });
  assert.equal(initialized.config.action, "created");
  assert.deepEqual((await readdir(workspace)).sort(), ["AGENTS.md", "taskchef.json", "tasks.jsonl"]);
  assert.equal(await readFile(path.join(workspace, "tasks.jsonl"), "utf8"), "");

  const repeated = await initializeWorkspace(workspace);
  assert.equal(repeated.config.action, "unchanged");
  assert.equal(repeated.tasks.action, "unchanged");
  assert.equal(repeated.instructions.action, "unchanged");
  assert.deepEqual(repeated.legacySkills.removed, []);
});

test("public task history API uses task terminology", () => {
  for (const name of ["buildTaskSummary", "filterTasks", "listTasks", "readTask", "recordTask"]) {
    assert.equal(typeof taskchef[name], "function");
  }
  for (const name of [
    "buildDispatchSummary", "filterDispatches", "readDispatch", "readDispatches", "recordDispatch",
  ]) {
    assert.equal(name in taskchef, false);
  }
});

test("init removes legacy TaskChef skill links without deleting unrelated skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-legacy-skills-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  const skillsDirectory = path.join(workspace, ".agents", "skills");
  await mkdir(path.join(skillsDirectory, "other-skill"), { recursive: true });
  for (const skillName of ["taskchef-bootstrap", "taskchef-delegate", "taskchef-reconcile"]) {
    await symlink(path.join(root, "old-source", skillName), path.join(skillsDirectory, skillName));
  }

  const stale = await doctorWorkspace(workspace);
  assert.equal(stale.ok, false);
  assert.match(
    stale.checks.find((check) => check.name === "legacy-skill-links").message,
    /run workspace init/,
  );

  const refreshed = await initializeWorkspace(workspace);
  assert.deepEqual(
    refreshed.legacySkills.removed.map((link) => link.name),
    ["taskchef-bootstrap", "taskchef-delegate", "taskchef-reconcile"],
  );
  assert.equal((await lstat(path.join(skillsDirectory, "other-skill"))).isDirectory(), true);
  assert.equal((await doctorWorkspace(workspace)).ok, true);

  const compatibility = await ensureWorkspaceSkills(workspace);
  assert.equal(compatibility.directory, null);
  assert.deepEqual(
    compatibility.skills.map((skill) => skill.action),
    ["provided-by-plugin", "provided-by-plugin", "provided-by-plugin"],
  );

  const onlyLegacy = path.join(root, "only-legacy");
  await mkdir(path.join(onlyLegacy, ".agents", "skills"), { recursive: true });
  for (const skillName of ["taskchef-bootstrap", "taskchef-delegate", "taskchef-reconcile"]) {
    await symlink(path.join(root, "old-source", skillName), path.join(onlyLegacy, ".agents", "skills", skillName));
  }
  const cleaned = await initializeWorkspace(onlyLegacy);
  assert.equal(cleaned.legacySkills.removedDirectories.length, 2);
  await assert.rejects(lstat(path.join(onlyLegacy, ".agents")), { code: "ENOENT" });
});

test("init refuses to delete a non-symlink legacy TaskChef skill path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-legacy-skill-directory-"));
  const skillPath = path.join(root, ".agents", "skills", "taskchef-bootstrap");
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "KEEP"), "user content\n");
  await assert.rejects(initializeWorkspace(root), /legacy TaskChef skill path is not a symlink/);
  assert.equal(await readFile(path.join(skillPath, "KEEP"), "utf8"), "user content\n");
});

test("init leaves unrelated symlinked agents paths untouched", async () => {
  for (const symlinkSkillsDirectory of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-unrelated-agents-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(outside, "KEEP"), "unrelated content\n");
    if (symlinkSkillsDirectory) {
      await mkdir(path.join(workspace, ".agents"));
      await symlink(outside, path.join(workspace, ".agents", "skills"), "dir");
    } else {
      await symlink(outside, path.join(workspace, ".agents"), "dir");
    }

    await initializeWorkspace(workspace);
    assert.equal(await readFile(path.join(outside, "KEEP"), "utf8"), "unrelated content\n");
    assert.equal((await doctorWorkspace(workspace)).ok, true);
  }
});

test("plugin manifest packages all skills and stays synchronized by release tooling", async () => {
  const manifest = JSON.parse(await readFile(path.resolve(".codex-plugin/plugin.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  assert.equal(manifest.name, "taskchef");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(packageJson.files.includes(".codex-plugin"), true);
  const releaseConfig = JSON.parse(await readFile(path.resolve(".releaserc.json"), "utf8"));
  const releasePluginNames = releaseConfig.plugins.map((plugin) =>
    Array.isArray(plugin) ? plugin[0] : plugin);
  for (const pluginName of [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
  ]) {
    const plugin = releaseConfig.plugins.find((entry) =>
      Array.isArray(entry) && entry[0] === pluginName);
    assert.equal(plugin[1].preset, "conventionalcommits");
  }
  assert.ok(
    releasePluginNames.indexOf("@semantic-release/exec")
      < releasePluginNames.indexOf("@semantic-release/npm"),
    "the plugin manifest version must be synchronized before npm creates the release tarball",
  );
  const releaseGitPlugin = releaseConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/git",
  );
  assert.deepEqual(
    releaseGitPlugin[1].assets,
    [".codex-plugin/plugin.json", "package-lock.json", "package.json"],
  );
  for (const skillName of ["taskchef-bootstrap", "taskchef-delegate", "taskchef-report"]) {
    assert.equal(
      (await lstat(path.resolve("skills", skillName, "SKILL.md"))).isFile(),
      true,
    );
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-plugin-version-"));
  await mkdir(path.join(root, ".codex-plugin"));
  await writeFile(
    path.join(root, ".codex-plugin", "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await execFile(process.execPath, [path.resolve("scripts/sync-plugin-version.js"), "2.3.4"], {
    cwd: root,
  });
  const synchronized = JSON.parse(
    await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8"),
  );
  assert.equal(synchronized.version, "2.3.4");

  const outputPath = path.join(root, "github-output");
  await execFile("git", ["init"], { cwd: root });
  await execFile("git", ["add", ".codex-plugin/plugin.json"], { cwd: root });
  await execFile("git", [
    "-c", "user.name=TaskChef Test", "-c", "user.email=test@example.com",
    "commit", "-m", "test release version",
  ], { cwd: root });
  await execFile(process.execPath, [path.resolve("scripts/write-release-version-output.js")], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: outputPath },
  });
  assert.equal(await readFile(outputPath, "utf8"), "version=\n");
  await execFile("git", ["tag", "v2.3.4"], { cwd: root });
  const taggedOutputPath = path.join(root, "tagged-github-output");
  await execFile(process.execPath, [path.resolve("scripts/write-release-version-output.js")], {
    cwd: root,
    env: { ...process.env, GITHUB_OUTPUT: taggedOutputPath },
  });
  assert.equal(await readFile(taggedOutputPath, "utf8"), "version=2.3.4\n");
});

test("release automation pins the shared marketplace to the exact npm version", async () => {
  const marketplace = {
    name: "favoyang-plugins",
    plugins: [
      {
        name: "taskchef",
        source: {
          source: "url",
          url: "https://github.com/favoyang/taskchef.git",
          ref: "main",
        },
      },
    ],
  };
  const pinned = pinTaskChefNpmSource(marketplace, "2.3.4");
  assert.equal(pinned.changed, true);
  assert.deepEqual(marketplace.plugins[0].source, {
    source: "npm",
    package: "taskchef",
    version: "2.3.4",
    registry: "https://registry.npmjs.org",
  });
  assert.equal(pinTaskChefNpmSource(marketplace, "2.3.4").changed, false);
  assert.throws(() => pinTaskChefNpmSource(marketplace, "latest"), /invalid TaskChef/);

  const packedRelease = [{
    id: "taskchef@2.3.4",
    files: [
      { path: ".codex-plugin/plugin.json" },
      { path: "bin/taskchef.js", mode: 0o755 },
      { path: "src/cli.js" },
      { path: "src/workspace.js" },
      { path: "skills/taskchef-bootstrap/SKILL.md" },
      { path: "skills/taskchef-delegate/SKILL.md" },
      { path: "skills/taskchef-report/SKILL.md" },
    ],
  }];
  assert.equal(validatePublishedPluginPackage(packedRelease, "2.3.4").id, "taskchef@2.3.4");
  assert.throws(
    () => validatePublishedPluginPackage([
      { ...packedRelease[0], files: packedRelease[0].files.slice(1) },
    ], "2.3.4"),
    /missing \.codex-plugin\/plugin\.json/,
  );
  assert.throws(
    () => validatePublishedPluginPackage([{
      ...packedRelease[0],
      files: packedRelease[0].files.map((file) =>
        file.path === "bin/taskchef.js" ? { ...file, mode: 0o644 } : file),
    }], "2.3.4"),
    /bin\/taskchef\.js is not executable/,
  );
  const currentPackage = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  assert.equal(
    (await validateExtractedPlugin(path.resolve("."), currentPackage.version)).name,
    "taskchef",
  );
  assert.throws(
    () => validateSkillFrontmatter(
      "---\nname: taskchef-delegate\ndescription: [unterminated\n---\n",
      "taskchef-delegate",
    ),
    /invalid YAML/,
  );
  const dependencyInstalls = [];
  await installPublishedPluginDependencies("/tmp/taskchef-package", async (...args) => {
    dependencyInstalls.push(args);
  });
  assert.deepEqual(dependencyInstalls, [[
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: "/tmp/taskchef-package", maxBuffer: 1024 * 1024 },
  ]]);

  let registryAttempts = 0;
  const verifiedVersions = [];
  assert.equal(
    await resolveExpectedPublishedPlugin("2.3.4", {
      attempts: 2,
      delayMs: 0,
      readVersionImpl: async () => {
        registryAttempts += 1;
        return registryAttempts === 1 ? "1.0.2" : "2.3.4";
      },
      verifyVersionImpl: async (version) => {
        verifiedVersions.push(version);
      },
      waitImpl: async () => {},
    }),
    "2.3.4",
  );
  assert.equal(registryAttempts, 2);
  assert.deepEqual(verifiedVersions, ["2.3.4"]);

  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-marketplace-update-"));
  const marketplacePath = path.join(root, "marketplace.json");
  await writeFile(marketplacePath, `${JSON.stringify({
    name: "favoyang-plugins",
    plugins: [{
      name: "taskchef",
      source: {
        source: "url",
        url: "https://github.com/favoyang/taskchef.git",
        ref: "codex/taskchef-plugin",
      },
    }],
  })}\n`);
  assert.deepEqual(
    await preserveSharedMarketplaceFile(marketplacePath),
    { changed: true },
  );
  const fallbackMarketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  assert.equal(fallbackMarketplace.plugins[0].source.ref, "main");
  const result = await updateSharedMarketplaceFile(marketplacePath, "2.3.4");
  assert.deepEqual(result, { changed: true, version: "2.3.4" });
  const writtenMarketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  assert.equal(writtenMarketplace.plugins[0].source.version, "2.3.4");
  assert.deepEqual(
    await updateSharedMarketplaceFile(marketplacePath, "2.3.4"),
    { changed: false, version: "2.3.4" },
  );
  assert.deepEqual(
    await preserveSharedMarketplaceFile(marketplacePath),
    { changed: false },
  );

  const workflow = await readFile(path.resolve(".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /ssh-key: \$\{\{ secrets\.MARKETPLACE_DEPLOY_KEY \}\}/);
  assert.match(workflow, /node scripts\/update-shared-marketplace\.js shared-marketplace/);
  assert.match(workflow, /git push origin HEAD:main/);
  assert.match(workflow, /marketplace:\n[\s\S]+needs:\n\s+- test\n\s+- release/);
  assert.match(workflow, /marketplace:\n[\s\S]+always\(\)/);
  assert.match(workflow, /needs\.release\.result == 'success'/);
  assert.match(workflow, /needs\.release\.outputs\.expected-version != ''/);
  assert.match(workflow, /expected-version: \$\{\{ steps\.expected-version\.outputs\.version \}\}/);
  assert.match(workflow, /run: node scripts\/write-release-version-output\.js/);
  assert.match(workflow, /EXPECTED_VERSION: \$\{\{ needs\.release\.outputs\.expected-version \}\}/);
  assert.match(workflow, /update-shared-marketplace\.js shared-marketplace\/\.agents\/plugins\/marketplace\.json "\$EXPECTED_VERSION"/);
  assert.match(workflow, /steps\.marketplace-update\.outputs\.npm_ready != 'true'/);
});

test("init preserves existing configuration and merges managed instructions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-merge-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "AGENTS.md"), "# Personal instructions\n\n- Keep me.\n");
  const initialized = await initializeWorkspace(workspace);
  assert.equal(initialized.instructions.action, "merged");
  const content = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
  assert.match(content, /Keep me/);
  assert.match(content, /\$taskchef-bootstrap/);
  assert.doesNotMatch(content, /For every ordinary user prompt/);
  assert.ok(content.indexOf("$taskchef-report") > content.indexOf("Answer directly only"));

  const project = await gitProject(root, "project");
  await addProject(workspace, { name: "project", path: project });
  await initializeWorkspace(workspace);
  assert.equal((await readConfig(workspace)).projects.length, 1);
});

test("delegate skill isolates trigger metadata and uses complete CLI commands", async () => {
  const content = await readFile(path.resolve("skills/taskchef-delegate/SKILL.md"), "utf8");
  const frontmatter = content.match(/^---\n([\s\S]+?)\n---/)?.[1] ?? "";
  assert.equal(
    frontmatter.match(/^description:.*$/m)?.[0],
    'description: "Dispatch actionable requests from an initialized TaskChef workspace into independently openable Codex project tasks. Use for ordinary work requests in a TaskChef workspace, explicit delegation, or splitting independent work across projects. Record successful dispatches, return immediately, and never use subagents, hooks, schedules, or foreground waiting."',
  );
  assert.doesNotMatch(frontmatter, /\$[a-z0-9-]+/);
  assert.doesNotMatch(frontmatter, /\btaskchef-(?:bootstrap|report)\b/);

  const body = content.slice(content.indexOf("\n---", 4) + 4);
  const literals = [...body.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(
    literals.filter((literal) => /\btaskchef\.js(?:\s|$)/.test(literal)),
    [
      "<plugin-root>/bin/taskchef.js project list --json --workspace <workspace>",
      "<plugin-root>/bin/taskchef.js task record --json --workspace <workspace>",
    ],
  );
  assert.equal(literals.some((literal) => /^(?:doctor|workspace|task|dispatch)\s/.test(literal)), false);
  assert.match(body, /do not write anything yet/);
  assert.match(body, /If executor creation fails, do not record a task/);
});

test("report skill reads live task state once without persisting it", async () => {
  const content = await readFile(path.resolve("skills/taskchef-report/SKILL.md"), "utf8");
  assert.match(content, /^name: taskchef-report$/m);
  assert.match(content, /taskchef\.js task show <task-id> --json --workspace/);
  assert.match(content, /taskchef\.js task list --project <name-or-path> --json --workspace/);
  assert.match(content, /Use the full list only when the user asks for an overview/);
  assert.match(content, /no more than eight targets per call/);
  assert.match(content, /Never update `tasks\.jsonl`/);
  assert.match(content, /Do not poll or wait/);
  assert.doesNotMatch(content, /task update|reconcile-candidates/);
});

test("init fails safely on malformed managed instruction markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-invalid-instructions-"));
  await writeFile(
    path.join(root, "AGENTS.md"),
    "<!-- taskchef:dispatcher-instructions:start -->\ntruncated\n",
  );
  await assert.rejects(initializeWorkspace(root), /malformed TaskChef managed-block markers/);
  await assert.rejects(readFile(path.join(root, "taskchef.json"), "utf8"), { code: "ENOENT" });
});

test("init rejects a symlinked dispatch log", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-symlinked-managed-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await mkdir(workspace);
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(workspace, "tasks.jsonl"));

  await assert.rejects(
    initializeWorkspace(workspace),
    /managed workspace path is not a regular file/,
  );
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("init rejects symlinked managed workspace files without reading them", async () => {
  for (const fileName of ["AGENTS.md", "taskchef.json", "tasks.jsonl"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-symlinked-file-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(outside, "sensitive outside content\n");
    await symlink(outside, path.join(workspace, fileName));

    await assert.rejects(
      initializeWorkspace(workspace),
      /managed workspace path is not a regular file/,
    );
    assert.equal(await readFile(outside, "utf8"), "sensitive outside content\n");
    assert.equal((await lstat(path.join(workspace, fileName))).isSymbolicLink(), true);
  }
});

test("project add detects Git roots and normalizes GitHub remotes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-project-add-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  const projectPath = await gitProject(root, "source", "git@github.com:Example/source.git");
  const project = await addProject(workspace, {
    name: "source",
    path: projectPath,
    description: "Owns source code.",
  });
  assert.deepEqual(project, {
    name: "source",
    path: projectPath,
    isGitRepository: true,
    githubRepo: "https://github.com/Example/source",
    description: "Owns source code.",
  });
  await assert.rejects(addProject(workspace, { name: "duplicate", path: projectPath }), /duplicates/);

  const nested = path.join(projectPath, "nested");
  await mkdir(nested);
  await assert.rejects(addProject(workspace, { path: nested }), /Git repository root/);
});

test("project add supports non-Git directories and explicit GitHub suppression", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-project-kinds-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  const notes = path.join(root, "notes");
  await mkdir(notes);
  const folder = await addProject(workspace, { path: notes });
  assert.equal(folder.name, "notes");
  assert.equal(folder.isGitRepository, false);
  assert.equal(folder.githubRepo, null);
  await assert.rejects(
    addProject(workspace, { path: path.join(root, "missing") }),
    /does not exist/,
  );
});

test("project inspection reports Git execution failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-git-failure-"));
  const workspace = path.join(root, "workspace");
  const project = path.join(root, "project");
  await initializeWorkspace(workspace);
  await mkdir(project);
  const originalPath = process.env.PATH;
  process.env.PATH = path.join(root, "missing-bin");
  try {
    await assert.rejects(
      addProject(workspace, { path: project }),
      /failed to inspect Git repository/,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("project import merges by canonical path and preserves omitted curation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-import-"));
  const workspace = path.join(root, "workspace");
  await initializeWorkspace(workspace);
  const first = await gitProject(root, "first");
  const second = await gitProject(root, "second");
  await addProject(workspace, {
    name: "curated-first",
    path: first,
    description: "Preserve this description.",
  });
  const merged = await importProjects(workspace, [{ path: first }, { name: "second", path: second }]);
  assert.equal(merged.mode, "merge");
  assert.equal(merged.projectCount, 2);
  const projects = await listProjects(workspace);
  assert.equal(projects.find((project) => project.path === first).name, "curated-first");
  assert.equal(
    projects.find((project) => project.path === first).description,
    "Preserve this description.",
  );

  const replaced = await importProjects(workspace, [{ name: "second-only", path: second }], {
    replace: true,
  });
  assert.equal(replaced.mode, "replace");
  assert.deepEqual((await listProjects(workspace)).map((project) => project.name), ["second-only"]);
  await assert.rejects(importProjects(workspace, {}), /JSON array/);
});

test("project removal and replacement preserve historical dispatch snapshots", async () => {
  const { root, workspace, projects } = await fixture(1);
  await recordTask(workspace, dispatchInput(projects[0]), { now: FIXED_TIME });
  await removeProject(workspace, "project-1");
  assert.deepEqual(await listProjects(workspace), []);
  assert.equal((await readTask(workspace, "dispatch-1")).project.name, "project-1");

  const replacement = await gitProject(root, "replacement");
  const result = await importProjects(
    workspace,
    [{ name: "replacement", path: replacement }],
    { replace: true },
  );
  assert.deepEqual(result.projects.map((project) => project.path), [replacement]);
});

test("moved projects can be removed or replaced through configuration repair", async () => {
  const removable = await fixture(1);
  await rename(removable.projects[0], `${removable.projects[0]}-moved`);
  await initializeWorkspace(removable.workspace);
  const removed = await removeProject(removable.workspace, "project-1");
  assert.equal(removed.project.path, removable.projects[0]);
  assert.deepEqual(await listProjects(removable.workspace), []);

  const replaceable = await fixture(1);
  await rename(replaceable.projects[0], `${replaceable.projects[0]}-moved`);
  const replacement = await gitProject(replaceable.root, "replacement");
  const replaced = await importProjects(
    replaceable.workspace,
    [{ name: "replacement", path: replacement }],
    { replace: true },
  );
  assert.deepEqual(replaced.projects.map((project) => project.path), [replacement]);
});

test("configuration and dispatch schemas remain strict", async () => {
  await assert.rejects(
    validateConfig({ schemaVersion: 1, projects: [], hostId: "forbidden" }),
    /unsupported field: hostId/,
  );
  const { workspace, projects } = await fixture(1);
  await assert.rejects(
    recordTask(workspace, { ...dispatchInput(projects[0]), status: "running" }),
    /unsupported field: status/,
  );
  assert.throws(() => requireSafeId("../escape"), /unsupported characters/);
});

test("dispatch recording appends one immutable journey entry", async () => {
  const { workspace, projects } = await fixture(1);
  const recorded = await recordTask(workspace, dispatchInput(projects[0]), { now: FIXED_TIME });
  assert.equal(recorded.createdAt, FIXED_TIME);
  assert.equal(recorded.project.name, "project-1");
  assert.deepEqual(Object.keys(recorded), [
    "schemaVersion", "id", "project", "title", "instruction", "threadId", "createdAt",
  ]);
  const content = await readFile(path.join(workspace, "tasks.jsonl"), "utf8");
  assert.equal(content.split("\n").length, 2);
  assert.deepEqual(JSON.parse(content.trim()), recorded);
});

test("dispatch recording rejects duplicate IDs and thread IDs", async () => {
  const { workspace, projects } = await fixture(1);
  await recordTask(workspace, dispatchInput(projects[0], "dispatch-a", "thread-a"));
  await assert.rejects(
    recordTask(workspace, dispatchInput(projects[0], "dispatch-a", "thread-b")),
    /task already exists/,
  );
  await assert.rejects(
    recordTask(workspace, dispatchInput(projects[0], "dispatch-b", "thread-a")),
    /threadId is already recorded/,
  );
});

test("concurrent dispatch recording cannot poison the journey", async () => {
  const { workspace, projects } = await fixture(1);
  const input = dispatchInput(projects[0], "same", "same-thread");
  const settled = await Promise.allSettled([
    recordTask(workspace, input),
    recordTask(workspace, input),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
  assert.match(settled.find((item) => item.status === "rejected").reason.message, /already/);
  assert.deepEqual((await listTasks(workspace)).map((item) => item.id), ["same"]);
  await assert.rejects(lstat(path.join(workspace, ".taskchef-dispatch.lock")), { code: "ENOENT" });

  await Promise.all([
    recordTask(workspace, dispatchInput(projects[0], "distinct-a", "thread-distinct-a")),
    recordTask(workspace, dispatchInput(projects[0], "distinct-b", "thread-distinct-b")),
  ]);
  const ids = (await listTasks(workspace)).map((item) => item.id);
  assert.equal(ids[0], "same");
  assert.deepEqual(ids.slice(1).sort(), ["distinct-a", "distinct-b"]);

  const cliInput = JSON.stringify(dispatchInput(projects[0], "cross-process", "thread-cross"));
  const processes = await Promise.allSettled([
    runCli(["task", "record", "--json", "--workspace", workspace], { input: cliInput }),
    runCli(["task", "record", "--json", "--workspace", workspace], { input: cliInput }),
  ]);
  assert.equal(processes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(processes.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await listTasks(workspace)).filter((item) => item.id === "cross-process").length, 1);
});

test("dispatch operations recover an abandoned lock", async () => {
  const { workspace, projects } = await fixture(1);
  const lockPath = path.join(workspace, ".taskchef-dispatch.lock");
  await mkdir(lockPath);

  await recordTask(workspace, dispatchInput(projects[0], "after-crash", "thread-after-crash"));
  assert.deepEqual((await listTasks(workspace)).map((item) => item.id), ["after-crash"]);
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

test("journey reads and doctor do not require workspace write access", async () => {
  const { workspace, projects } = await fixture(1);
  await recordTask(workspace, dispatchInput(projects[0]));
  const lockPath = path.join(workspace, ".taskchef-dispatch.lock");
  await chmod(workspace, 0o555);
  try {
    assert.equal((await listTasks(workspace)).length, 1);
    assert.equal((await doctorWorkspace(workspace)).ok, true);
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
  } finally {
    await chmod(workspace, 0o755);
  }
});

test("dispatch list filters by historical project and summary counts the journey", async () => {
  const { workspace, projects } = await fixture(2);
  await recordTask(workspace, dispatchInput(projects[0], "first", "thread-first"));
  await recordTask(workspace, dispatchInput(projects[0], "second", "thread-second"));
  await recordTask(workspace, dispatchInput(projects[1], "third", "thread-third"));

  assert.deepEqual(
    (await filterTasks(workspace, { project: "PROJECT-1" })).map((item) => item.id),
    ["first", "second"],
  );
  assert.deepEqual(await filterTasks(workspace, { project: "unused" }), []);
  assert.deepEqual(await buildTaskSummary(workspace), {
    schemaVersion: 1,
    taskCount: 3,
    projectCounts: { "project-1": 2, "project-2": 1 },
  });
});

test("dispatch reader rejects malformed and non-terminated JSONL", async () => {
  const { workspace } = await fixture(1);
  const log = path.join(workspace, "tasks.jsonl");
  await writeFile(log, "{bad}\n");
  await assert.rejects(listTasks(workspace), /line 1 is invalid JSON/);
  await writeFile(log, JSON.stringify({ id: "incomplete" }));
  await assert.rejects(listTasks(workspace), /must end with a newline/);
  await writeFile(log, "\n");
  await assert.rejects(listTasks(workspace), /line 1 is empty/);
});

test("doctor reports healthy and stale workspaces without mutating them", async () => {
  const { workspace } = await fixture(1);
  const healthy = await doctorWorkspace(workspace);
  assert.equal(healthy.ok, true);
  await writeFile(path.join(workspace, "AGENTS.md"), "# stale\n");
  const stale = await doctorWorkspace(workspace);
  assert.equal(stale.ok, false);
  assert.equal(stale.checks.find((check) => check.name === "instructions").status, "fail");
  assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), "# stale\n");
  await ensureWorkspaceInstructions(workspace);
  assert.equal((await doctorWorkspace(workspace)).ok, true);
});

test("workspace init migrates completed legacy task records without status or results", async () => {
  const { workspace, projects } = await fixture(1);
  const tasks = path.join(workspace, "tasks");
  const taskDirectory = path.join(tasks, "legacy-1");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(path.join(taskDirectory, "task.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "legacy-1",
    project: projects[0],
    title: "Legacy work",
    instruction: "Finish the legacy work.",
    status: "finished",
    threadId: "thread-legacy",
    result: { message: "Done.", githubPRs: [], githubIssues: [] },
    createdAt: FIXED_TIME,
    updatedAt: LATER_TIME,
  })}\n`);

  const initialized = await initializeWorkspace(workspace);
  assert.equal(initialized.legacyTasks.action, "migrated");
  assert.equal(initialized.legacyTasks.migratedCount, 1);
  await assert.rejects(lstat(tasks), { code: "ENOENT" });
  const migrated = await readTask(workspace, "legacy-1");
  assert.equal(migrated.threadId, "thread-legacy");
  assert.equal("status" in migrated, false);
  assert.equal("result" in migrated, false);
});

test("workspace init migrates a legacy task whose project was force-removed", async () => {
  const { workspace, projects } = await fixture(1);
  await removeProject(workspace, "project-1");
  const taskDirectory = path.join(workspace, "tasks", "orphaned-1");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(path.join(taskDirectory, "task.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "orphaned-1",
    project: projects[0],
    title: "Orphaned legacy work",
    instruction: "Finish the orphaned legacy work.",
    status: "finished",
    threadId: "thread-orphaned",
    result: null,
    createdAt: FIXED_TIME,
    updatedAt: LATER_TIME,
  })}\n`);

  const initialized = await initializeWorkspace(workspace);
  assert.equal(initialized.legacyTasks.migratedCount, 1);
  const migrated = await readTask(workspace, "orphaned-1");
  assert.equal(migrated.project.path, projects[0]);
  assert.equal(migrated.project.isGitRepository, true);
});

test("workspace init resumes legacy cleanup after task.json was removed", async () => {
  const { workspace, projects } = await fixture(1);
  await recordTask(
    workspace,
    dispatchInput(projects[0], "cleanup-1", "thread-cleanup"),
    { now: FIXED_TIME },
  );
  const taskDirectory = path.join(workspace, "tasks", "cleanup-1");
  await mkdir(taskDirectory, { recursive: true });

  const initialized = await initializeWorkspace(workspace);
  assert.equal(initialized.legacyTasks.action, "migrated");
  assert.equal(initialized.legacyTasks.migratedCount, 0);
  await assert.rejects(lstat(path.join(workspace, "tasks")), { code: "ENOENT" });
  assert.equal((await listTasks(workspace)).filter((item) => item.id === "cleanup-1").length, 1);
});

test("legacy cleanup resumes from the saved snapshot after its project moves", async () => {
  const { workspace, projects } = await fixture(1);
  await recordTask(
    workspace,
    dispatchInput(projects[0], "moved-cleanup", "thread-moved-cleanup"),
    { now: FIXED_TIME },
  );
  await removeProject(workspace, "project-1");
  const taskDirectory = path.join(workspace, "tasks", "moved-cleanup");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(path.join(taskDirectory, "task.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "moved-cleanup",
    project: projects[0],
    title: "Echo input",
    instruction: "Create echo_input.py, test it, and report the result.",
    status: "finished",
    threadId: "thread-moved-cleanup",
    result: null,
    createdAt: FIXED_TIME,
    updatedAt: LATER_TIME,
  })}\n`);
  await rename(projects[0], `${projects[0]}-moved`);

  const initialized = await initializeWorkspace(workspace);
  assert.equal(initialized.legacyTasks.migratedCount, 0);
  await assert.rejects(lstat(path.join(workspace, "tasks")), { code: "ENOENT" });
  assert.equal((await readTask(workspace, "moved-cleanup")).project.path, projects[0]);
});

test("legacy cleanup compares normalized fields after an interrupted migration", async () => {
  const { workspace, projects } = await fixture(1);
  await recordTask(
    workspace,
    {
      id: "trimmed-cleanup",
      project: projects[0],
      title: " Echo input ",
      instruction: " Create echo_input.py, test it, and report the result. ",
      threadId: " thread-trimmed ",
    },
    { now: FIXED_TIME },
  );
  const taskDirectory = path.join(workspace, "tasks", "trimmed-cleanup");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(path.join(taskDirectory, "task.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "trimmed-cleanup",
    project: projects[0],
    title: " Echo input ",
    instruction: " Create echo_input.py, test it, and report the result. ",
    status: "finished",
    threadId: " thread-trimmed ",
    result: null,
    createdAt: FIXED_TIME,
    updatedAt: LATER_TIME,
  })}\n`);

  const initialized = await initializeWorkspace(workspace);
  assert.equal(initialized.legacyTasks.migratedCount, 0);
  await assert.rejects(lstat(path.join(workspace, "tasks")), { code: "ENOENT" });
});

test("legacy cleanup rejects a same-ID task from a different project", async () => {
  const { workspace, projects } = await fixture(2);
  await recordTask(
    workspace,
    dispatchInput(projects[0], "project-conflict", "thread-conflict"),
    { now: FIXED_TIME },
  );
  const taskDirectory = path.join(workspace, "tasks", "project-conflict");
  const taskPath = path.join(taskDirectory, "task.json");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(taskPath, `${JSON.stringify({
    schemaVersion: 1,
    id: "project-conflict",
    project: projects[1],
    title: "Echo input",
    instruction: "Create echo_input.py, test it, and report the result.",
    status: "finished",
    threadId: "thread-conflict",
    result: null,
    createdAt: FIXED_TIME,
    updatedAt: LATER_TIME,
  })}\n`);

  await assert.rejects(initializeWorkspace(workspace), /conflicts with task history/);
  assert.equal((await lstat(taskPath)).isFile(), true);
});

test("workspace init stops when a pending legacy task has no executor", async () => {
  const { root, workspace, projects } = await fixture(1);
  await unlink(path.join(workspace, "tasks.jsonl"));
  const legacySkill = path.join(workspace, ".agents", "skills", "taskchef-delegate");
  await mkdir(path.dirname(legacySkill), { recursive: true });
  await symlink(path.join(root, "legacy-taskchef-delegate"), legacySkill);
  const taskDirectory = path.join(workspace, "tasks", "pending-1");
  await mkdir(taskDirectory, { recursive: true });
  const taskPath = path.join(taskDirectory, "task.json");
  await writeFile(taskPath, `${JSON.stringify({
    schemaVersion: 1,
    id: "pending-1",
    project: projects[0],
    title: "Pending work",
    instruction: "Do pending work.",
    status: "pending",
    threadId: null,
    result: null,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  })}\n`);
  await assert.rejects(initializeWorkspace(workspace), /has no executor thread/);
  assert.equal((await lstat(taskPath)).isFile(), true);
  assert.equal((await lstat(legacySkill)).isSymbolicLink(), true);
  await assert.rejects(lstat(path.join(workspace, "tasks.jsonl")), { code: "ENOENT" });
});

test("CLI implements the bootstrap, project, doctor, and task surface", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskchef-cli-v2-"));
  const workspace = path.join(root, "workspace");
  const first = await gitProject(root, "first", "https://github.com/example/first.git");
  const second = await gitProject(root, "second");

  const initialized = await runCli(["workspace", "init", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(initialized.stdout).config.action, "created");
  const added = await runCli([
    "project", "add", first, "--name", "first", "--json", "--workspace", workspace,
  ]);
  assert.equal(JSON.parse(added.stdout).githubRepo, "https://github.com/example/first");
  const imported = await runCli([
    "project", "import", "-", "--json", "--workspace", workspace,
  ], { input: JSON.stringify([{ name: "second", path: second }]) });
  assert.equal(JSON.parse(imported.stdout).projectCount, 2);
  const projects = await runCli(["project", "list", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(projects.stdout).projectCount, 2);

  await runCli(["task", "record", "--json", "--workspace", workspace], {
    input: JSON.stringify(dispatchInput(first)),
  });
  const shown = await runCli(["task", "show", "dispatch-1", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(shown.stdout).id, "dispatch-1");
  const listed = await runCli([
    "task", "list", "--project", "first", "--json", "--workspace", workspace,
  ]);
  assert.deepEqual(JSON.parse(listed.stdout).tasks.map((item) => item.id), ["dispatch-1"]);
  const summary = await runCli(["task", "summary", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(summary.stdout).taskCount, 1);
  assert.equal(JSON.parse(summary.stdout).projectCounts.first, 1);
  const doctor = await runCli(["doctor", "--json", "--workspace", workspace]);
  assert.equal(JSON.parse(doctor.stdout).ok, true);
});

test("CLI rejects removed legacy commands", async () => {
  for (const args of [
    ["workspace", "ensure-instructions", "--json"],
    ["workspace", "ensure-skills", "--json"],
    ["config", "validate", "--json"],
    ["task", "snapshot", "--json"],
    ["dispatch", "record", "--json"],
    ["dispatch", "list", "--json"],
  ]) {
    await assert.rejects(
      runCli(args),
      (error) => error.code === 2 && /Unknown command/.test(error.stderr),
    );
  }
});
