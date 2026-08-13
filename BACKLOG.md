# TaskChef backlog

`SPEC.md` is the current contract. These ideas need a concrete user case and a
clear data model before implementation.

## Task history views

- Add date ranges and title search if the task log becomes difficult to
  browse.
- Consider export formats for personal activity reports.
- Define archival or retention only when real logs become large enough to need
  it.
- Consider grouping entries created from one broad request without storing the
  full original prompt.

## Optional reports

- Consider user-scheduled, read-only digests that query recorded Codex tasks
  and publish a report without writing status or results to the TaskChef
  workspace.
- Define batching and partial-read behavior for large task histories.
- Decide whether inaccessible or deleted Codex tasks need a separate report
  category.

## Remote projects

- Import remote connection projects returned by native project discovery.
- Persist the native project and host identity needed to distinguish identical
  paths on different hosts.
- Re-resolve remote identities before dispatch.
- Define unavailable-host, renamed-project, moved-path, and stale-identity
  behavior.
- Evaluate isolated worktrees and conflict handling for concurrent tasks in one
  project.

## Integrations

- Add GitHub automation only when task history alone is insufficient.
- Evaluate automatic project discovery rules and exclusions.
- Consider multiple executor threads for one logical assignment if a real
  workflow requires it.

## Codex provisional thread lifecycle

- Track [openai/codex#26861](https://github.com/openai/codex/issues/26861),
  where worktree creation can return only a provisional `clientThreadId` or
  `pendingWorktreeId` with no supported mapping to the durable `threadId`.
- Prefer an official bounded operation such as
  `wait_for_thread(clientThreadId, timeoutMs) -> { status, threadId? }` or
  `resolve_client_thread(clientThreadId) -> { status, threadId? }`. Returning a
  reserved durable ID from `create_thread`, or emitting a materialization event
  containing it, would also close the lifecycle gap.
- Re-evaluate TaskChef's sparse marker-discovery fallback when Codex exposes
  one of these APIs. Keep exact marker verification before persisting the
  returned durable ID unless the official contract provides equivalent
  correlation guarantees.

## Structured task recording tool

- Investigate bundling a local stdio MCP server in the TaskChef plugin so Codex
  can call focused `prepare_dispatch`, `record_task`, and `resolve_task` tools
  with structured inputs instead of invoking the data CLI through a shell.
- Reuse the existing `prepareDispatch`, `recordTask`, and `resolveTask` APIs so
  the MCP layer cannot bypass canonical workspace resolution, exact-field
  validation, locking, atomic replacement, unique durable-thread correlation,
  or one-way nullable resolution.
- Prototype canonical `~/.agents/taskchef` access before committing to this
  design. Verify how bundled MCP processes interact with Codex filesystem
  sandboxing and plugin-scoped tool approval on every supported local surface.
- Keep native Codex task creation outside the MCP server unless Codex exposes a
  supported task-creation API to plugins. The intended sequence is structured
  TaskChef preparation, native `create_thread`, then structured TaskChef record
  and optional resolution.
- Evaluate tool schemas, approval annotations, failure reporting, installation
  and upgrade behavior, process lifetime, and latency against the Phase 1 CLI
  baseline before replacing the CLI path.
- Relevant official documentation:
  <https://developers.openai.com/plugins/concepts/plugins>,
  <https://developers.openai.com/plugins/concepts/mcp-server>,
  <https://developers.openai.com/plugins/build/mcp-server>, and
  <https://developers.openai.com/plugins/build/plugins>.
