---
name: taskchef-bootstrap
description: "Initialize, diagnose, or refresh TaskChef dispatcher workspaces, project configuration, task history, and managed AGENTS.md instructions. Use when creating a TaskChef workspace, adding, importing, listing, or removing configured projects, running TaskChef doctor, or repairing dispatcher setup. Do not dispatch user work or report on executor threads."
---

# TaskChef Bootstrap

Initialize or refresh the per-user TaskChef dispatcher workspace at
`~/.agents/taskchef`.

Resolve this skill directory with `realpath`. The TaskChef plugin root is two
parents above the skill directory. Invoke `<plugin-root>/bin/taskchef.js` for
all deterministic workspace operations.

## Boundaries

- Keep implementation, tests, and reports in the TaskChef source repository.
- Create and manage only `AGENTS.md`, `taskchef.json`, and `tasks.jsonl` in a
  dispatcher workspace. Preserve unrelated user-owned paths.
- Do not dispatch tasks or report on executor threads during bootstrap unless
  the user separately requests those actions.
- Never create hooks, schedules, polling, or daemons. TaskChef executors
  self-link through the installed MCP server.

## Initialize and repair

1. Run `workspace path --json` and use its returned canonical path for native
   project comparisons. The CLI resolves `--workspace`, then
   an absolute (or `~/`-prefixed) `TASKCHEF_WORKSPACE`, then
   `~/.agents/taskchef`; do not infer a workspace
   from the current project.
2. List native Codex projects once. If an exact canonical-path local project
   already exists, run `workspace init --json`. Otherwise run
   `workspace init --register-codex --json`, then list native projects once more
   and require one exact canonical-path local project. `--register-codex`
   invokes the supported `codex app <path>` command through a validated Codex
   CLI discovered from the current desktop environment; never invoke
   `codex add` or hard-code an application bundle path.
3. `workspace init` takes no stdin, creates an empty
   configuration when missing, creates the one-entry-per-task JSONL log, refreshes
   managed instructions, and removes legacy TaskChef skill links. The installed
   plugin provides all three TaskChef skills outside the dispatcher workspace.
4. Run `doctor --json` after setup or when the user asks to diagnose the
   workspace. Doctor is read-only. Rerun `workspace init --json` to repair the
   managed scaffold.
5. Report the actions or failed checks. A successful initialization with failed
   Codex opening remains initialized but not verified as a saved local project.
   End without dispatching unless the user
   separately requested work.

## Configure projects

1. Reuse the native Codex project list from initialization when available.
   Configure only
   projects local to the TaskChef workspace's execution host. Remote connection
   projects are outside the v1 contract.
   Never configure the TaskChef dispatcher workspace or a directory containing
   it as a routing target.
2. Add one project with `project add <path>`, normally supplying `--name` and a
   curated `--description`. The CLI detects Git status, exact Git root, and a
   canonical GitHub `origin`. Repeat `--github-repo <url>` to advertise several
   repositories, or use `--no-github` for an empty list. A managed
   `*-workspace` project must list all of its child or sub-repositories so issue
   and pull-request URLs route to that workspace.
3. Bulk import with `project import <file|-> --json`. Input is a JSON array of
   objects containing `path` plus optional `name`, `description`, and
   `githubRepos`, which is always a JSON array of GitHub repository URLs. Import
   merges by canonical path, preserves an existing name or description when
   omitted, and unions existing and imported repository lists without
   duplicates. Use `--replace` only when the user explicitly requests
   replacement.
4. Inspect configured projects with `project list --json`. Remove by name with
   `project remove`. Existing task entries keep their project snapshots.

Example managed-workspace import entry:

```json
{
  "name": "skills-workspace",
  "path": "/workspace/skills-workspace",
  "githubRepos": [
    "https://github.com/example/skill-one",
    "https://github.com/example/skill-two"
  ],
  "description": "Manages the listed child skill repositories."
}
```

`workspace init` safely migrates schema-version-1 configuration: a string
`githubRepo` becomes a one-item `githubRepos` list and `null` becomes
`githubRepos: []`. All subsequent configuration writes use schema version 2.
