# Delegation and result design

TaskChef stores a durable local task history while Codex owns execution. The
dispatcher records intent, the executor registers its own identity, and only
the executor reports semantic outcomes.

## Lifecycle

1. `prepare_dispatch` returns a fresh task UUID, exact marker, timestamp, and
   configured projects.
2. The dispatcher calls `record_task` with the complete marked instruction and
   `threadId: null` before native creation.
3. The dispatcher creates the Codex task and returns immediately. A durable or
   provisional creation result is never treated as authority to link the
   record.
4. As its first TaskChef action, the executor reads its own durable native
   thread ID and calls `link_task(taskId, threadId)`.
5. Before ending a turn with a semantic outcome, the executor reads that exact
   thread, takes the current turn ID, and calls `report_result`.

There is no task listing, candidate read, marker search, wait, retry loop,
transcript read, or hook in the dispatch path. The existing filesystem watcher
notices the atomic `link_task` rewrite and immediately refreshes the dashboard.

## Identity guarantees

The exact marker correlates the child instruction with the pre-created record.
The executor must use its native current thread ID, never the delegation
`sourceThreadId`, parent task, inherited session identity, title, or provisional
client ID.

`link_task` runs under the workspace lock. It permits one atomic
`null`-to-durable transition, rejects malformed or provisional IDs, rejects a
thread already owned by another TaskChef task, rejects a different retry, and
returns the existing snapshot for an identical retry.

Custom MCP does not currently authenticate the calling Codex task. The thread
ID is therefore a cooperative assertion inside TaskChef's local single-user
trust boundary. The design prevents accidental parent/child confusion but does
not claim resistance to a deliberately forged local MCP call.

## Failure and retry behavior

If native creation fails after recording, the dispatcher writes one terminal
`failed` result with null thread and turn IDs and a bounded summary. If the
executor is interrupted, cancelled, cannot see `link_task`, or gets a rejected
link, the record remains `working` with `threadId: null`. That visible
link-pending state is retryable on a later turn. TaskChef never guesses or
recovers identity through the dashboard.

## Result freshness

Linked results require an exact thread-ID match and a non-null current turn ID.
For self-linked schema 4 journeys, the native time-ordered Codex UUID must be
strictly newer for every changed result; exact same-turn retries remain safe.
Identical `report_result` retries are safe. A follow-up or resumed executor must
read its exact task again and report the new turn ID; reusing the initial turn
cannot establish freshness.

The latest snapshot fields are `status`, bounded `summary`, `turnId`,
`updatedAt`, and `updatedBy`. Historical `updatedBy: hook` values remain
readable, but new installations contain no hook and new writes use `dispatcher`
or `mcp`.

## Legacy recovery

`taskchef task resolve` is retained only for unresolved schema 1-3 records.
Operators must establish one exact marker match and one unique durable child
ID. Schema 4 self-linking records reject manual resolution. History is read
compatibly and is not eagerly rewritten.

## Dashboard and reports

The dashboard deep link uses only the stored self-linked child ID. File watcher
events surface linking and results without user interaction. Reporting may
compare current native metadata with cached semantic results, but it never
writes inferred lifecycle state.
