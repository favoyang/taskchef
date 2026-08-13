# TaskChef specification

## Purpose

TaskChef is an interactive Codex dispatcher. It routes independent assignments
to real Codex tasks in configured local projects, records each submitted
delegation in a task history, and returns immediately. New tasks append; only a
nullable thread ID may later transition to its durable value.

Codex tasks remain authoritative for their progress and results. TaskChef does
not maintain a second lifecycle database.

## Core behavior

1. The user submits a request in the dispatcher workspace or explicitly invokes
   the delegation skill from another Codex project.
2. TaskChef separates only outcomes that can proceed independently.
3. It selects each target using configured project metadata and validates the
   selected local path.
4. It creates an independently openable Codex task in that project.
5. It embeds a generated TaskChef UUID marker in the initial instruction before
   creation. It appends one task entry as soon as creation returns, using
   `threadId: null` while a provisional client ID is briefly resolved.
6. It returns without waiting for executor work to complete.
7. When requested, TaskChef can read task entries, query the relevant Codex
   tasks once, and present a live report without persisting the fetched state.

Several active executors may target the same project.

## Workspace layout

```text
~/.agents/taskchef/
├── AGENTS.md
├── taskchef.json
└── tasks.jsonl
```

`AGENTS.md` contains a marked block that routes setup and administration to
`$taskchef-bootstrap`, actionable work to `$taskchef-delegate`, and explicit
live report requests to `$taskchef-report`. Bootstrap preserves unrelated
instructions and refreshes only the managed block.

`workspace init` is idempotent. It creates an empty configuration and task
log when missing, refreshes managed instructions, and removes legacy TaskChef
skill symlinks.

Every command resolves one workspace in this precedence order:

1. explicit `--workspace <path>`
2. `TASKCHEF_WORKSPACE`
3. `~/.agents/taskchef`

The current directory is never an implicit workspace. `workspace path` exposes
the resolved absolute path and its source. Bootstrap compares this canonical
path with native Codex projects, and when absent invokes the validated
`codex app <path>` command before verifying the native list again. It never
uses `codex add` or a hard-coded application bundle path.

`doctor` validates configuration, project paths, the JSONL log, managed
instructions, and the absence of legacy TaskChef skill links without modifying
the workspace.

Neither the workspace nor any directory containing it can be configured as a
delegation project. All project configuration and task-history mutations share
one cross-process workspace lock. Writers reread and validate state while
holding that lock and publish complete files by atomic replacement.

## Project configuration

`taskchef.json` is the user-facing routing configuration:

```json
{
  "schemaVersion": 2,
  "projects": [
    {
      "name": "payments-api",
      "path": "/workspace/payments-api",
      "isGitRepository": true,
      "githubRepos": [
        "https://github.com/example/payments-api",
        "https://github.com/example/payments-sdk"
      ],
      "description": "Owns payment authorization, capture, refunds, and provider integrations."
    },
    {
      "name": "local-data-tools",
      "path": "/workspace/local-data-tools",
      "isGitRepository": false,
      "githubRepos": []
    }
  ]
}
```

- `schemaVersion` identifies the configuration format.
- `projects` lists the local routing targets.
- `name` is the unique human-readable project identity.
- `path` is the normalized, canonical local directory. A Git project must use
  its repository root.
- `isGitRepository` identifies Git and non-Git projects.
- `githubRepos` is a deduplicated list of canonical GitHub repository URLs. Use
  `[]` when the project advertises no repositories. A managed `*-workspace`
  project lists each child or sub-repository that should route to it.
- `description` is optional routing context.

TaskChef classifies work against `name`, every URL in `githubRepos`, and
`description`. The path identifies the checkout but is not a routing hint. For
a GitHub issue or pull-request URL, TaskChef compares canonical,
case-insensitive owner/repository identities across every configured list. It
ignores the issue or PR suffix, `http` versus `https`, optional `www`, trailing
slashes, and trailing `.git`. It routes only when one configured project
matches; ambiguous and unmatched URLs are never guessed.

`project add` and `project import` detect Git status, exact Git roots, and
canonical GitHub origins. `--github-repo` is repeatable. Import merges by
canonical path, preserves an existing name or description when omitted, and
unions existing and imported repository lists without duplicates. `--replace`
replaces the configured set. Removing or replacing a project does not alter
historical task entries.

Schema version 2 replaces the string-or-null `githubRepo` field with the
list-valued `githubRepos` field. Schema-version-1 configurations remain
compatible: reads normalize a legacy string to one canonical list item and
legacy `null` to `[]`; `workspace init` persists the migration atomically, and
any later configuration write emits version 2.

The configuration does not store dispatcher identity, execution modes,
schedules, task status, results, host information, or the workspace path.

## Task entry

`tasks.jsonl` contains one compact JSON object per line, in append order:

```json
{"schemaVersion":2,"id":"c0f010ff-84f2-4838-a69d-0ff1f5d721d7","project":{"name":"payments-api","path":"/workspace/payments-api","isGitRepository":true,"githubRepos":["https://github.com/example/payments-api","https://github.com/example/payments-sdk"],"description":"Owns payment authorization, capture, refunds, and provider integrations."},"title":"Add payment retry logs","instruction":"<!-- taskchef_id=c0f010ff-84f2-4838-a69d-0ff1f5d721d7 -->\n\nAdd structured logs for failed payment retries and test them.","threadId":"019f9d46-f42c-7482-9707-3c107bf241ee","createdAt":"2026-08-08T10:00:00.000Z"}
```

- `schemaVersion` identifies the task entry format.
- `id` is a unique TaskChef task identifier.
- `project` is the complete configured project snapshot used for routing.
- `title` is a short task name.
- `instruction` is the complete executor instruction, including its first-line
  `<!-- taskchef_id=<full UUID> -->` correlation marker and the blank line that
  follows it.
- `threadId` identifies the created Codex task, or is `null` when creation was
  accepted but bounded marker resolution did not find one durable task ID.
- `createdAt` is the dispatch time as an ISO 8601 timestamp.

Every entry has exactly these fields. IDs and non-null thread IDs must be
unique; any number of unresolved entries may have `threadId: null`. The file is
empty or newline terminated, with no blank lines. TaskChef rejects a malformed
log instead of skipping bad entries. Writers replace the complete validated
file atomically under a workspace lock, so an interrupted write leaves either
the old history or the complete new history.

Task creation appends entries. The only permitted mutation is an atomic,
idempotent `task resolve` transition from `threadId: null` to one unique durable
thread ID. Resolution requires the stored instruction's exact marker to match
the task ID. A resolved or mismatched entry cannot be overwritten.

The project snapshot preserves the route even if the project is renamed,
moved, or removed later. Entries never contain status, result, transcript,
hidden reasoning, `hostId`, or update timestamps.

New task entries use schema version 2 and list-valued project snapshots.
Version 1 entries with string or null repository metadata remain readable and
normalize to version 2 in API and CLI output. Historical task entries with the
old heading-style marker also remain readable. New nullable records, candidate
matching, and resolution require the exact HTML-comment marker; TaskChef never
uses an old marker to correlate a thread. Direct records that already have a
durable thread ID remain marker-independent because they do not use recovery.
TaskChef does not eagerly rewrite legacy history solely for these compatibility
cases.

## Dispatch workflow

For each assignment, `$taskchef-delegate`:

1. runs `dispatch prepare` and native Codex project discovery concurrently;
   the preparation command resolves the canonical workspace, loads and
   validates configured projects, and generates the full UUID, preparation
   timestamp, and exact marker in one process
2. selects one unambiguous configured target and matches its exact path against
   the already-loaded native projects
3. prefixes the instruction with the prepared exact
   `<!-- taskchef_id=<UUID> -->` marker as the first line, followed by a blank
   line
4. creates a real Codex task at the exact configured path
5. appends a task entry immediately through closed, non-interactive stdin when
   creation returns a durable thread ID; it never opens a TTY or writes a
   temporary record file, and requests canonical-workspace write permission on
   the first attempt when the command sandbox does not allow that path
6. when creation returns only a provisional client ID, immediately appends the
   marked entry with `threadId: null`, then prefers one native client-ID wait or
   resolution call with a 30-second timeout when Codex exposes one
7. when no native operation is available, takes at most two recent-thread
   snapshots near 10 and 30 seconds after the provisional result, filters
   candidates by available host/project/time/worktree metadata, uses title only
   as an advisory ordering hint, and accepts only one thread whose structured
   delegated input starts with the exact marker
8. atomically fills the nullable thread ID after an exact match
9. returns after recording or after reporting that bounded resolution was
   unresolved, without waiting for executor work completion.

The exact random marker makes a pre-creation thread snapshot unnecessary.
Creation-time filtering allows five seconds of clock skew. Candidate reads run
concurrently where the host permits and inspect only structured
`codexDelegation.input`, never untrusted title, summary, preview, or plain-text
marker echoes. A native resolver result is verified against the same structured
marker before persistence. Zero exact matches time out unresolved; multiple
exact matches are ambiguous. Snapshot, candidate-read, native-resolution, or
task-resolution errors leave the already-recorded nullable entry intact. No
snapshot, candidate read, marker verification, or task-resolution write starts
after the 30-second deadline, so tool latency can reduce the number of attempts.
A `clientThreadId`, `pendingWorktreeId`, or ID in the documented provisional
`local:` namespace remains diagnostic context and is rejected from every path
that could persist the canonical `threadId` field.

Desktop thread tools are available to the Codex skill, not to the standalone
Node CLI. The package therefore exposes testable marker/filter/orchestration
helpers with injected thread-tool callbacks, while the skill owns the actual
desktop-tool calls and the CLI remains responsible only for validated data
operations.

`task record` rejects an interactive TTY before reading because its protocol is
exactly one JSON value followed by EOF. Workspace-lock contention is retried for
up to seven seconds, while permanent permission failures such as `EPERM` or
`EACCES` fail immediately so the caller can request the required permission
without paying the contention retry budget.

A failed executor creation produces no entry. If executor creation succeeds but
the append fails, the executor remains valid and TaskChef tells the user that
it was not recorded.

## Task history and live reports

The CLI reads persisted history without contacting Codex:

- `task show <id>` returns one entry.
- `task list` returns entries newest-first by creation time, optionally filtered
  by historical project name or exact path. `--ascending` returns oldest-first.
  The selected order applies to both human rows and the JSON `tasks` array.
- `task summary` returns the total and per-project counts.
- `task resolve <id> --thread-id <thread-id>` atomically fills one nullable
  thread ID after Codex verifies the exact structured marker match.

When the user requests current state or outcomes, `$taskchef-report` makes one
marker-based discovery pass for nullable entries and uses `task resolve` only
for a single exact match. It reports unmatched entries as unresolved and
queries every durable thread ID exactly once, in batches of no more than eight.
The report does not poll, wait, persist status or results, or create a scheduled
job.

## Boundaries

TaskChef does not include:

- lifecycle status or result persistence
- task callbacks, hooks, indefinite polling, daemons, heartbeats, or schedules
- arbitrary Codex task discovery beyond bounded marker-based creation recovery
- remote hosts or `hostId` storage
- transcript or hidden-reasoning collection
- one-active-task-per-project restrictions
- batch cancellation or replay
- bundled development runtimes in dispatcher workspaces.

## Acceptance test

1. Bootstrap creates `AGENTS.md`, `taskchef.json`, and `tasks.jsonl`, then
   remains idempotent.
2. Project metadata routes an unambiguous request to the correct local project.
3. A successful delegation creates a visible Codex task and appends its thread
   ID with a project snapshot.
4. A provisional creation with one exact marker match records its durable
   thread ID; zero or multiple matches record `threadId: null` for later
   recovery.
5. The dispatcher returns without waiting for execution.
6. Several independent assignments can create several entries, including
   multiple entries for the same project.
7. Task history commands return deterministic entries and project counts.
8. A live report queries each relevant task once and writes nothing.
9. Malformed JSONL, duplicate IDs, duplicate thread IDs, and symlinked managed
   files fail safely.
