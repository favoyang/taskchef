---
name: taskchef-bootstrap
description: "Initialize or repair the TaskChef dispatcher workspace and manage its local Codex project index. Use for setup, doctor, import, or reindex requests; not dispatch or executor reporting."
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

## Project index operations

For adding, importing, removing, listing, or reindexing projects, read
[project index](references/project-index.md). Preserve exact canonical local
Codex project identity and existing curated entries; opening a folder is not
proof of registration. Completion requires verifying the intended index entry.

## Optional model roles

Offer planner, implementer, and reviewer profiles during setup. Model and effort
preferences belong in user configuration, never defaults hard-coded in skills.
If the user provides values, configure them without asking again. Otherwise
explain the optional profiles and retain native defaults until values are chosen.

Run `python3 <plugin-root>/scripts/roles/resolve_roles.py` to preview personal
roles. Python 3.11+ is required for this optional helper. Create each requested
missing profile with:

```sh
python3 <plugin-root>/scripts/roles/resolve_roles.py --setup --role <role> --model <requested-model> --effort <requested-effort>
```

This authorized role setup may create `$CODEX_HOME/agents/<role>.toml` (default
`~/.codex/agents/`) outside the dispatcher workspace. Existing definitions,
including custom filenames, are preserved. Report conflicts and diagnostics;
never overwrite a custom role. Re-run the preview and check model/effort against
the available native interface. Missing roles are optional: TaskChef omits
new-task overrides; reviewers inherit parent settings. Native new-task defaults
are not guaranteed dispatcher inheritance. Read the delegate's
[role resolution](../taskchef-delegate/references/model-roles.md) for precedence
and adapter limits. Open the dashboard's `/#settings` preview to show the
configured sources, requested effective settings, fallback, and problems.
