# Project index operations

Resolve the plugin root and use its CLI as described in SKILL.md.

## Index Codex projects

TaskChef's project index is the local list of Codex projects available for
delegation. It stores canonical paths and routing metadata such as curated
names, descriptions, Git status, and GitHub repositories. It does not index
repository contents or create a second kind of project.

For a whole-project refresh, pass the agent's single native schema-2
`list_projects` snapshot to `reconcile_projects`. TaskChef validates local
`hostId: local` entries, canonicalizes each path, isolates per-project failures,
adds new eligible paths, and binds native project IDs only by exact same-host
canonical path. It preserves curated names, descriptions, and complete
repository lists. Missing native entries are retained; duplicate identities,
duplicate canonical targets, and identity/path moves return diagnostics.

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
Codex, list native projects once and call `reconcile_projects` once with that
exact snapshot. After reconciliation, run `project list --json` once and
verify every intended canonical path and its routing metadata before reporting
the index as current.

Do not call `project add` for a path already in the TaskChef index; it rejects
duplicate paths and must not be presented as a metadata refresh. Preserve
existing curated entries, and do not remove entries merely because they are
absent from the current Codex list. Refreshing or removing an existing entry
requires an explicit user request and the project-management workflows below.

## Manage the project index

Before every mutation, run project list --json and retain the complete
normalized project set, count, and configHash. Use project update for changes
to one existing entry, including replacing its complete githubRepos list.
Never use whole-index replacement to edit one entry.

Run destructive replacement or removal first with --dry-run. Present the
complete diff and exact removed project names to the user and obtain explicit
permission for those removals. Apply only with the preview's config hash,
before/after counts, plan hash, exact removed-name JSON file, and count-collapse
confirmation when requested. A request to remove a repository URL is not
permission to remove a project entry. Do not use a generic force or yes flag.

1. Bulk import with `project import <file|-> --json`. Input is a JSON array of
   objects containing `path` plus optional `name`, `description`, and
   `githubRepos`, which is always a JSON array of GitHub repository URLs. Before
   importing, list native local Codex projects once, canonicalize every input
   path, and require an exact local-project match for every entry. Reject or
   report every unmatched path instead of indexing it. Import merges by
   canonical path, preserves an existing name or description when omitted, and
   unions existing and imported repository lists without duplicates. Use
   `--replace` only when the user explicitly requests replacement. Run
   `project list --json` afterward and compare the complete project set with the
   expected post-state. Verify every imported entry and prove all unrelated
   entries are unchanged; matching counts alone are insufficient.
2. Inspect indexed projects with project list --json. Update one entry with
   project update; explicit repository arguments are the complete replacement
   list. Remove by name only through the preview-bound workflow. Existing task
   entries keep their project snapshots.
3. On any postcondition mismatch, stop, report the failure, and offer backup
   list plus a restore dry-run. Never restore automatically.

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

TaskChef accepts configuration schema version 2 only. Its optional exact
`dashboard` object contains boolean `autostart`; absence means enabled and
`false` opts out of MCP-lifecycle dashboard startup without disabling manual
`$taskchef-dashboard` recovery. `githubRepos` is always an array; unsupported
configuration is rejected without being rewritten.

Schema 2 also accepts an optional strict `projectIndex` object holding local
native identity bindings, explicit exclusions, and bounded routing hints.
Absence means empty state. Removing a project records an exclusion so later
reconciliation cannot silently re-add it; an explicit `include_project` clears
that exclusion. Aliases require explicit user selection. Repository facts
require an inspected exact origin, including a contained Git root when a
workspace owns child repositories. Report-derived responsibilities retain the
accepted task, thread, and turn as compact provenance. Forgetting retains a
bounded suppression entry so an old report retry cannot recreate the fact.
Older TaskChef releases reject configurations containing `projectIndex`;
downgrade by restoring a compatible backup rather than editing live state.
