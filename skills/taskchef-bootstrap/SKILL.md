---
name: taskchef-bootstrap
description: "Initialize, diagnose, or refresh TaskChef dispatcher workspaces, the Codex project index, task history, and managed AGENTS.md instructions. Use when creating a TaskChef workspace, indexing or reindexing Codex projects, importing, listing, or removing indexed projects, running TaskChef doctor, or repairing dispatcher setup. Do not dispatch user work or report on executor threads."
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
- Never create hooks, schedules, polling, daemons, login items, or system
  services. The managed dispatcher instructions own best-effort dashboard
  startup and final-link guidance; bootstrap only refreshes that managed block.
  TaskChef executors self-link through the installed MCP server.

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
   configuration when missing, creates the one-entry-per-task JSONL log, and
   refreshes managed instructions. The installed plugin provides all four
   TaskChef skills outside the dispatcher workspace.
4. Run `doctor --json` after setup or when the user asks to diagnose the
   workspace. Doctor is read-only. Rerun `workspace init --json` to repair the
   managed scaffold.
5. Report the actions or failed checks. A successful initialization with failed
   Codex opening remains initialized but not verified as a saved local project.
   End without dispatching unless the user
   separately requested work.

## Index Codex projects

TaskChef's project index is the local list of Codex projects available for
delegation. It stores canonical paths and routing metadata such as curated
names, descriptions, Git status, and GitHub repositories. It does not index
repository contents or create a second kind of project.

Index only Codex projects local to the TaskChef workspace's execution host.
Remote connection projects are outside the v1 contract. Never index the
TaskChef dispatcher workspace or a directory containing it; the dispatcher is
the inbox, while indexed Codex projects own delegated work.

### Existing Codex project

1. List native local Codex projects once. Resolve the requested existing folder
   with `realpath` and require an exact canonical-path match in that list. A
   similar name, a parent or child directory, and a remote connection project
   are not matches.
2. Index the exact path with the existing `project add <canonical-path> --name
   <curated-name> --description <curated-description> --json` CLI workflow.
   Despite the command's historical `add` name, this writes one TaskChef index
   entry for an existing Codex project. The CLI detects Git status, the exact
   Git root, and a canonical GitHub `origin` when no repository option is
   supplied. Repeated `--github-repo <canonical-url>` arguments replace that
   detection and form the complete advertised repository list, so repeat the
   origin explicitly when it should remain routable. Use `--no-github` when the
   user intentionally wants an empty list.
3. Run `project list --json` and require one indexed entry with the exact
   canonical path and intended routing metadata. Only then report that the
   Codex project is ready for delegation through TaskChef.

### New or not-yet-saved Codex folder

1. Create the folder only when the user explicitly asked to create it. Preserve
   unrelated existing contents. Do not initialize Git unless requested or
   clearly required by the user's broader task. Resolve the resulting existing
   folder with `realpath`.
2. Register or open that exact canonical folder with the supported
   `<validated-codex-cli> app <canonical-path>` mechanism. Reuse a validated CLI
   path supplied by the current Codex Desktop environment when available. Use
   the same resolver contract as `workspace init --register-codex` otherwise:
   an explicit `--codex-cli` path takes precedence over `TASKCHEF_CODEX_CLI`;
   each must resolve to an executable that passes `app --help`. Without an
   override, inspect `codex` executables from `PATH`, prefer a validated
   candidate whose path contains `Contents/Resources`, and otherwise validate
   only the first executable `codex` in PATH order. Never assume an arbitrary
   shell `codex`, invoke `codex add`, or hard-code an application bundle path.
3. Re-list native local Codex projects and require an exact canonical-path
   match. Opening is a request, not proof that Codex saved the project. If the
   exact match is absent, report that the folder was opened or registration was
   requested but Codex registration remains unverified; do not index it in
   TaskChef or call it delegation-ready.
4. After Codex verification, index the project as in the existing-project path.
   Run `project list --json` and verify the exact TaskChef index entry. Report
   delegation readiness only after both the native Codex match and TaskChef
   indexing are verified.

For a managed `*-workspace` Codex project, advertise every relevant child or
subrepository with repeated `--github-repo <canonical-github-url>` arguments,
including the workspace repository itself when it can own issue or pull-request
links. These explicit values are the complete list; automatic origin detection
does not supplement them. This lets TaskChef route each canonical GitHub URL to
the correct workspace rather than guessing from the folder name.

### Reindex after Codex changes

When the user asks TaskChef to reindex or catch up after saving more projects in
Codex, list native local Codex projects once and run `project list --json` once
before mutation. Compare exact canonical paths, then index each requested
eligible Codex project that is missing from TaskChef by following the
appropriate path above, sharing the batch verification instead of relisting
after each write. After all additions, run `project list --json` once more and
verify every intended canonical path and its routing metadata before reporting
the index as current.

Do not call `project add` for a path already in the TaskChef index; it rejects
duplicate paths and must not be presented as a metadata refresh. Preserve
existing curated entries, and do not remove entries merely because they are
absent from the current Codex list. Refreshing or removing an existing entry
requires an explicit user request and the project-management workflows below.

## Manage the project index

1. Bulk import with `project import <file|-> --json`. Input is a JSON array of
   objects containing `path` plus optional `name`, `description`, and
   `githubRepos`, which is always a JSON array of GitHub repository URLs. Before
   importing, list native local Codex projects once, canonicalize every input
   path, and require an exact local-project match for every entry. Reject or
   report every unmatched path instead of indexing it. Import merges by
   canonical path, preserves an existing name or description when omitted, and
   unions existing and imported repository lists without duplicates. Use
   `--replace` only when the user explicitly requests replacement. Run
   `project list --json` afterward and verify every imported entry.
2. Inspect indexed projects with `project list --json`. Remove by name with
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

TaskChef accepts configuration schema version 2 only. `githubRepos` is always
an array; unsupported configuration is rejected without being rewritten.
