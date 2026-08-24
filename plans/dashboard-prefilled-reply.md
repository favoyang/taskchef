---
title: Continue a task with a prefilled draft
state: open
priority: P2
created_at: 2026-08-24
agent_sessions: []
---

## Goal

Let a user prepare a reply in the TaskChef dashboard and hand it to the exact
Codex task as a reviewed, prefilled draft without TaskChef executing or sending
the prompt automatically.

## Implementation

- [ ] Verify whether the current Codex desktop app exposes a documented draft
      handoff or prefill route for an existing thread; do not infer query
      parameters from the registered `codex:` scheme or use hidden APIs.
- [ ] Treat exact task identity as a prerequisite and reuse the corrected
      parent/child correlation validation from the live-state refresh plan.
- [ ] If a supported prefill contract exists, define a same-origin validated
      handoff containing only the selected UUID thread ID and user-authored draft,
      with strict size limits and no automatic submission.
- [ ] If no supported prefill contract exists, implement the safe fallback: an
      editable draft area, Copy draft, and Open task in Codex. Do not call
      `codex resume <session> [prompt]`, `send_message_to_thread`, or any route
      that immediately starts a turn.
- [ ] Preserve drafts only in the browser session by default, clearly indicate
      unsent state, and provide explicit discard behavior; never add drafts to
      `tasks.jsonl` or notifications.
- [ ] Add keyboard, accessibility, size-limit, escaping, wrong-thread,
      unsupported-contract, and no-auto-submit tests; document the chosen
      integration and pass the independent branch review gate.

## Acceptance criteria

- Opening or copying a draft never sends it.
- The destination is the exact child Codex task, not its creator or another task
  with a similar title.
- The UI always distinguishes Draft, Copied, Opened, and Sent; TaskChef itself
  never reports Sent unless Codex later exposes a supported confirmation event.
