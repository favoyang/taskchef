import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { CodexProjects } from "../src/codex-projects.js";
const task = (id, cwd, projectId) => ({ id, project: { id: projectId, name: "Folder", path: cwd, githubRepos: [] } });
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "next-projects-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, catalog: new CodexProjects(home) };
}
test("project assignments and Git worktree pointers share one registered project", async (t) => {
  const { home, catalog } = await fixture(t);
  const original = join(home, "original"); const worktree = join(home, "worktree");
  const gitdir = join(original, ".git", "worktrees", "branch");
  await mkdir(gitdir, { recursive: true }); await mkdir(worktree);
  await mkdir(join(worktree, "src", "nested"), { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
  await writeFile(join(gitdir, "commondir"), "../..\n");
  const registry = [{ id: "project", name: "My project", roots: [original] }, { id: "empty", name: "Empty project", roots: ["/empty"] }];
  const result = await catalog.group([task("one", original), task("two", worktree), task("three", "/missing/worktree", "project"), task("nested", join(worktree, "src", "nested"))], registry);
  assert.deepEqual(result.tasks.map((item) => item.project.id), ["project", "project", "project", "project"]);
  assert.deepEqual(result.tasks.map((item) => item.project.name), ["My project", "My project", "My project", "My project"]);
  assert.equal(result.tasks[1].project.path, worktree);
  await writeFile(join(home, ".codex-global-state.json"), JSON.stringify({ "thread-workspace-root-hints": { nested: "/unmatched/hint" } }));
  assert.equal((await catalog.group([task("nested", join(worktree, "src"))], registry)).tasks[0].project.id, "project");
  assert.equal(result.projects.length, 2); // Saved projects with no chats remain selectable.
});
test("legacy assignments, hints and projectless chats follow saved desktop metadata", async (t) => {
  const { home, catalog } = await fixture(t);
  const file = join(home, ".codex-global-state.json");
  await writeFile(file, JSON.stringify({
    "thread-project-assignments": { old: { projectKind: "local", projectId: "legacy" } },
    "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: { legacy: "new" } },
    "thread-workspace-root-hints": { hint: "/repo/src" }, "projectless-thread-ids": ["plain"],
    "local-projects": { deleted: { id: "deleted", name: "Deleted project", rootPaths: ["/gone"] } },
  }));
  const registry = [{ id: "new", name: "Saved name", roots: ["/repo"] }, { id: "nested", name: "Nested", roots: ["/repo/nested"] }];
  const result = await catalog.group([task("old", "/missing"), task("hint", "/missing"), task("plain", "/repo"),
    task("date1", join(homedir(), "Documents", "Codex", "2026-10-01", "chat")),
    task("date2", join(homedir(), "Documents", "Codex", "2026-10-02", "chat")), task("nested", "/repo/nested/src")], registry);
  assert.deepEqual(result.tasks.map((item) => item.project.id), ["new", "new", "projectless", "projectless", "projectless", "nested"]);
  assert.equal(result.projects.length, 2); // Stale legacy entries cannot resurrect deleted projects.
  await writeFile(file, JSON.stringify({ "thread-workspace-root-hints": { hint: "/repo/nested" } }));
  assert.equal((await catalog.group([task("hint", "/missing")], registry)).tasks[0].project.id, "nested");
});
test("invalid desktop project metadata is reported rather than silently ignored", async (t) => {
  const { home, catalog } = await fixture(t);
  await writeFile(join(home, ".codex-global-state.json"), "broken");
  await assert.rejects(catalog.group([], []), SyntaxError);
});
