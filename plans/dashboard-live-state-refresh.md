---
title: Refresh one task's live Codex state
state: open
priority: P2
created_at: 2026-08-24
agent_sessions: []
---

## Goal

Let a user manually refresh one TaskChef task's current Codex state through a
supported read-only integration, without polling, executing prompts, or trusting
an incorrect parent/child thread correlation.

## Implementation

- [ ] Verify the supported local Codex app-server or desktop integration for a
      read-only thread metadata snapshot, including authentication, lifecycle,
      versioning, and whether a standalone loopback server may use it.
- [ ] Reproduce the verified parent/child correlation failure with a sanitized
      fixture, then fix records that capture a creator ID instead of the child
      task ID.
- [ ] Make TaskChef identity resolution validate the exact task marker and
      returned child thread ID; reject ambiguous root/session IDs rather than
      silently linking the task to its creator.
- [ ] Design a same-origin validated `POST` refresh action that performs one
      bounded read for the selected task, applies timeouts and version checks,
      and never starts or resumes work.
- [ ] Keep live state separate from persisted semantic results: show running,
      waiting for approval, idle, or unavailable with source and observation
      time, while `report_result` remains the semantic outcome authority.
- [ ] Add parent/child, stale-ID, unavailable-app, timeout, authorization, and
      UI tests; document the no-polling behavior and pass the independent branch
      review gate.

## Acceptance criteria

- Refreshing a delegated child task targets its own Codex task ID, never its
  creator task.
- One click performs at most one supported metadata read and no prompt execution.
- Identity mismatch is shown as an actionable error and cannot overwrite the
  cached semantic result.
