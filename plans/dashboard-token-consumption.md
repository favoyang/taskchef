---
title: Display per-task token consumption
state: open
priority: P2
created_at: 2026-08-24
agent_sessions: []
---

## Goal

Display trustworthy per-task model token consumption in the TaskChef dashboard
without estimating usage, scraping private Codex transcripts, or weakening the
dashboard's local-data protections.

## Implementation

- [ ] Verify the current supported Codex metadata, app-server protocol, and CLI
      surfaces for per-thread and per-turn input, cached-input, output, and total
      token counts; document absence as a blocking contract when no supported
      source exists.
- [ ] Choose one structured source of truth: a supported Codex usage field, or
      an executor-reported TaskChef usage payload with explicit provenance and
      versioning. Do not parse rollout files, hidden logs, or rendered
      transcripts.
- [ ] Extend the TaskChef result/schema model compatibly so historical records
      remain readable and usage may be unknown, partial, or unavailable.
- [ ] Define aggregation rules across turns, retries, compaction, cached input,
      subagents, and continued work so the dashboard never double-counts or
      attributes child-task usage to its parent.
- [ ] Add an accessible task-detail usage section with clear units, provenance,
      last-updated time, and an unavailable state; avoid implying billing cost
      unless a supported cost field exists.
- [ ] Add schema, aggregation, privacy, rendering, and legacy-record tests, then
      update user documentation and pass the independent branch review gate.

## Acceptance criteria

- Every displayed value is traceable to a supported structured field.
- Parent and child Codex tasks retain separate usage totals and identities.
- Missing usage remains visibly unavailable rather than estimated as zero.
