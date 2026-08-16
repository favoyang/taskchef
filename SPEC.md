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

1. calls the structured `prepare_dispatch` tool and native Codex project
   discovery concurrently; the preparation tool resolves the canonical
   workspace, loads and
   validates configured projects, and generates the full UUID, preparation
   timestamp, and exact marker in one process; it never takes a pre-creation
   thread snapshot
2. selects one unambiguous configured target and matches its exact path against
   the already-loaded native projects
3. prefixes the instruction with the prepared exact
   `<!-- taskchef_id=<UUID> -->` marker as the first line, followed by a blank
   line
4. creates a real Codex task at the exact configured path
5. appends a task entry immediately through the structured `record_task` tool
   when creation returns a durable thread ID; it never opens a shell, parses
   stdin, writes a temporary record file, or probes command-sandbox permission
6. when creation returns only a provisional client ID, immediately appends the
   marked entry with `threadId: null`; the current supported Codex surface has
   no provisional-ID resolver, so the skill performs no post-creation tool
   availability inspection
7. takes at most two recent-thread
   snapshots on a nominal 10- and 30-second schedule after the provisional
   result; a late first checkpoint runs immediately, and the second starts at
   least 20 seconds after the first actually started. It filters candidates by
   available host/project/time/worktree metadata, uses title only as an advisory
   ordering hint, issues all independent candidate reads in exactly one
   programmatic batch per snapshot, and accepts only one thread whose structured
   delegated input starts with the exact marker; inability to execute that
   required batch leaves the nullable record unresolved instead of switching to
   serial reads
8. atomically fills the nullable thread ID with `resolve_task` after an exact
   match
9. returns after recording or after reporting that bounded resolution was
   unresolved, without waiting for executor work completion.

The exact random marker remains the sole correlation proof. Creation-time
filtering allows five seconds of clock skew. Candidate reads use exactly one
programmatic batch per snapshot and inspect only
structured `codexDelegation.input`, never untrusted title, summary, preview, or
plain-text marker echoes. Zero exact matches remain unresolved; multiple exact
matches are ambiguous. Snapshot, candidate-read, or task-resolution errors
leave the already-recorded nullable entry intact. The workflow is bounded by
two snapshots rather than an absolute wall-clock cutoff:
mandatory recording or tool latency can shift both attempts later, but cannot
erase an attempt or reduce the minimum 20-second interval between their start
times.
A `clientThreadId`, `pendingWorktreeId`, or ID in the documented provisional
`local:` namespace remains diagnostic context and is rejected from every path
that could persist the canonical `threadId` field.

The plugin bundles a local stdio MCP server with focused `prepare_dispatch`,
`record_task`, and `resolve_task` tools. It accepts no workspace path from the
model and resolves only `TASKCHEF_WORKSPACE` or the canonical
`~/.agents/taskchef` default. The write tools reuse the public workspace APIs,
so structured calls cannot bypass exact-field validation, locking, atomic
replacement, unique IDs, or one-way nullable resolution. They are closed-world
local mutations and never create Codex tasks. Desktop thread tools remain
available only to the Codex skill; the standalone CLI remains available for
bootstrap, manual inspection, and recovery.

### End-to-end benchmark results

An explicitly requested live benchmark writes one ignored, timestamped JSON
artifact through `scripts/e2e-benchmark.js`. Schema version 1 contains:

- benchmark name, TaskChef version, run ID, and wall-clock start/end
- project, title, and exact unmarked workload prompt
- TaskChef task ID, nullable durable/client IDs, recording state, resolution,
  and attempt count
- ISO start/end, derived duration, and outcome for preparation/project listing,
  task creation, recording, and optional provisional resolution
- boolean record, marker, executor-output, and candidate-filter-effectiveness
  validation results
- derived total wall time, measured stage time, orchestration overhead,
  resolution state, and attempt count

Stage outcomes are `success|failed` for preparation,
`durable|provisional|failed` for creation, `recorded|failed` for recording, and
`native|discovered|unresolved|failed` for provisional resolution. `failed`
distinguishes a terminal resolver error from a completed no-match checkpoint,
which must proceed to the second fallback attempt. Task resolution is
`immediate|native|discovered|unresolved`. Preparation failure has only the
preparation stage and a null task ID; creation failure stops after creation;
recording failure stops before provisional resolution. The committed example
shows the durable success shape, while these transition rules define the
shorter failure and longer provisional shapes.
The writer derives `taskchefVersion` from the running package instead of
trusting template input. Raw executor output and transcripts are never stored;
`outputVerified` records only whether the requested output was verified.

The writer rejects missing required stages, duplicate or unknown stages,
invalid timestamps, contradictory workflow outcomes, overlapping stages,
unknown fields, and overwriting an existing run. Later stages are omitted when
preparation or creation fails, and provisional resolution is omitted when task
recording fails. Fallback snapshot observations include the complete recent
task count plus the filtered candidate and exact-match counts, from which
candidate-filter effectiveness is checked. Each snapshot records
`resolveWriteOutcome` as `not-attempted`, `succeeded`, or `failed`, so a unique
match followed by an atomic write failure remains an honest unresolved result.
A compact valid starting document is committed as
`assets/e2e-benchmark-example.json`. Filenames use
`<startedAt-with-colons-replaced>-taskchef-delegate-e2e.json`. Its cleanup
operation removes only files matching the full generated filename grammar in
the selected results directory.

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

- `task show <id-or-8-character-prefix>` returns one entry. By default it emits
  labeled human-readable lines for title, project name and path, creation time,
  full task ID, thread ID, and instruction. A null thread ID renders as `-`.
  The instruction starts on the line after `Instruction:` and retains its
  stored line breaks and indentation. `--json` returns the unchanged complete
  task object. The short form is the exact ID text printed by the default
  human-readable `task list` output and succeeds only when it identifies
  exactly one recorded task. Missing, ambiguous, malformed, shorter, and
  wrong-case prefixes fail without selecting a task.
- `task list` returns entries newest-first by creation time, optionally filtered
  by historical project name or exact path. `--ascending` returns oldest-first.
  Human rows include task and thread ID columns, abbreviating UUID-shaped IDs
  to their first eight-character section unless `--full-id` is passed. Null
  thread IDs display as `-`. ID formatting does not alter JSON values, and the
  selected order applies to both human rows and the JSON `tasks` array.
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
