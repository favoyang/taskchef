---
name: taskchef-report
description: "Report useful current state for Codex tasks recorded by TaskChef. Use only when the user asks for delegated-task status, outcomes, or a report. Prefer cached semantic results, filter old terminal tasks from overviews, use one cheap live metadata snapshot to override active or approval-waiting tasks, and reserve detailed reads for anomalies. Never poll or wait."
---

# TaskChef Report

Read the canonical per-user TaskChef task snapshots and report useful current
state once. A stored result is cached semantic evidence, not permanent truth.

Resolve this skill directory with `realpath`. The TaskChef plugin root is two
parents above the skill directory. Invoke `<plugin-root>/bin/taskchef.js` for
all deterministic task-log operations.

## Report

1. Run `<plugin-root>/bin/taskchef.js workspace path --json`. The CLI resolves
   `--workspace`, then an absolute (or `~/`-prefixed) `TASKCHEF_WORKSPACE`, then
   `~/.agents/taskchef`; never
   infer the history from the current project. Select only the tasks the user
   asked about:
   - For an exact task ID, run
     `<plugin-root>/bin/taskchef.js task show <task-id> --json`.
   - For a project, run
     `<plugin-root>/bin/taskchef.js task list --project <name-or-path> --json`.
   - For a title or other description, run
     `<plugin-root>/bin/taskchef.js task list --json`
     once, then select matching entries. Ask the user if the match is ambiguous.
   - Use the full list only when the user asks for an overview of the task history.
2. For an overview, select only attention-worthy candidates before detailed
   reads:
   - always include `working`, `needs_input`, and entries with a null
     `threadId`;
   - include `completed` and `failed` entries updated during the last seven
     days;
   - omit older terminal entries by default and report the omitted count;
   - include any omitted task whose Codex metadata appears as active or awaiting
     native approval in the recent-thread snapshot.
   Explicit task, title, or project requests override this age filter.
3. Take one recent `list_threads` metadata snapshot for the whole report. This
   is a cheap contradiction check across many tasks, not one call per task.
   Match only exact durable `threadId` values. A metadata status that is active
   or awaiting native approval immediately overrides a cached result without a
   detailed read. Native approval is live Codex state, not a `needs_input`
   callback. An inactive status never proves semantic completion; it only
   permits a trustworthy cached MCP result to stand.
4. In schema 6, treat `status`, `turnId`, and `updatedAt` as the latest reported
   execution state and treat `results` as the ordered semantic history.
   `lastResult` is the derived compatibility alias for `results.at(-1)`; prefer
   the collection when full history matters and the alias for compact latest-state
   reporting. A `working` state with a non-null `lastResult` means a newer executor
   turn started after that result; show the prior result as history, not as the
   current outcome. Treat a failed `lastResult` with null thread and turn IDs as
   a fresh executor-creation failure. Schema 4/5 snapshots normalize zero or one
   semantic result into `results` and `lastResult` without rewriting their log line.
   No live read is possible or needed for that creation failure. When identity is certain and
   metadata says the thread is inactive, trust the latest semantic result by
   default in a broad overview unless a newer working state makes it historical.
   Do not read every idle terminal task in an overview merely because native
   `updatedAt` is later: callbacks normally run before Codex finalizes the same
   turn, and overview performance matters more than investigating every rare
   missed callback.

   For a focused task, title, or project report, perform at most one detailed
   read for each selected inactive task when matched metadata `updatedAt` is
   later than `lastResult.updatedAt`, by any amount. Read once as well
   when there is no semantic callback, identity or metadata is uncertain or
   contradictory, or the user explicitly requests a fully live result. If
   focused metadata is not newer, trust the cache. Absence from the bounded
   recent snapshot is not by itself a reason to read every cached terminal
   overview entry. Batch immediate native reads with no more than eight targets
   per call. When a detailed read occurs, compare the latest structured turn ID
   and native turn state with `lastResult.turnId`: a newer turn without a callback
   makes the cache stale, while an interrupted or cancelled callback turn
   cannot prove completion. Never classify assistant prose.
5. Report each task as one of: working, needs input, awaiting native approval,
   completed, failed, unresolved, or unknown. Show the cached summary when it
   remains fresh. If a newer turn exists without a callback, describe the live
   state and label the preserved result historical or stale rather than overwriting it.
6. Never edit `tasks.jsonl` directly during reporting. A null identity is
   executor link-pending and must be retried by that executor. Never persist inferred status,
   transcripts, prose classifications, or hidden reasoning. Do not poll or wait.

If the task history is empty, say that TaskChef has not recorded any tasks. If
a task has no durable thread ID and is not a stored creation failure, identify
it by task ID and say that its marker remains available for recovery. If live
metadata or a targeted read fails, use the cached result with an explicit
freshness warning and continue.
