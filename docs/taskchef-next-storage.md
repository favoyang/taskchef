# TaskChef Next: Codex storage

[Edit the Draw.io diagram](diagrams/taskchef-next-storage.drawio) · [Open the PNG](diagrams/taskchef-next-storage.drawio.png)

![Codex storage and lookup IDs](diagrams/taskchef-next-storage.drawio.png)

This diagram shows selected fields and logical lookup relationships. It does not show every column or claim that the databases enforce foreign keys. These internal schemas can change.

## One chat, two possible IDs

Suppose chat **C** has a turn **T**:

| Store | Ordinary history | After Codex selects a new rollout R |
| --- | --- | --- |
| `state_5.sqlite` → `threads.id` | C | C: the chat ID stays the same |
| `threads.rollout_path` | `rollout-<timestamp>-C.jsonl` | `rollout-<timestamp>-C_R.jsonl` |
| `thread_history_1.sqlite` → `thread_turns.thread_id` | C | R: use the ID after the underscore |
| `thread_turns.turn_id` | T | The latest turn in R |
| `thread_items.thread_id` | C | R |
| JSONL → `session_meta.payload.id` | C | C: this is still the chat ID |

The filename examples use C and R as short labels. Real filenames contain UUIDs. `.jsonl.zst` uses the same ID rule. Codex's [rollout filename resolver](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/metadata.rs) describes the separate ID after a revert. For paginated history, an unrecognized selected filename is an error. Legacy history supports noncanonical filenames with a stable chat-ID lookup. Old turn rows may remain under C. They belong to earlier history and must not replace the selected rollout's current turn.

TaskChef reads the filename from SQLite. It does not open the log to determine this lookup ID. Schedules, subagent links, navigation, and local Done marks continue to use the stable chat ID.

## Main tables and records

| File | Table or record | Example and use |
| --- | --- | --- |
| `state_5.sqlite` | `threads` | Chat C, name “Fix login”, project, archived flag, selected rollout path. Also holds model, reasoning effort, token total, pin and project metadata. |
| `state_5.sqlite` | `thread_spawn_edges` | Parent C → child D. Exclude D from the board; count it on C. |
| `thread_history_1.sqlite` | `thread_turns` | Rollout R, turn T, `status = completed`, duration and start/end times. This means the turn ended; the task may still need input or review. |
| `thread_history_1.sqlite` | `thread_items` | `(R, T, item I)` with `item_type = userMessage`, `agentMessage`, `commandExecution`, `mcpToolCall`, or `fileChange`. `item_json` contains the saved item body. The board reads the latest turn's first input to identify a heartbeat. It does not fetch every item. |
| `thread_history_1.sqlite` | `thread_history_projection_state` | R with the next byte offset and record ordinal. Tracks how far the saved history has been projected into SQLite. The board does not use it. |
| Rollout `.jsonl` | One JSON record per line | `type = session_meta`, `event_msg`, `response_item`, etc. The inner `payload.type` gives the event or response kind, such as `task_started` or `task_complete`. There are no SQL tables in this file. |

The optional log reader adds bounded message counts for one selected chat. It never supplies board status when SQLite fails.

## Other observed tables

The board does not query these tables. This list records table names seen during the local schema check; it is not a supported schema contract.

| Database | Other tables |
| --- | --- |
| `state_5.sqlite` | `_sqlx_migrations`, `thread_dynamic_tools`, `backfill_state`, `remote_control_enrollments`, `external_agent_config_imports`, `thread_sections`, `rollout_migration_state`, `rollout_migration_skipped_rollouts`, `projects`, `project_roots`, `project_idempotency_keys`, `thread_attachments` |
| `thread_history_1.sqlite` | `_sqlx_migrations`, `thread_realtime_items` |

TaskChef also reads heartbeat links from `automations/*/automation.toml`. Manual Done marks are saved in TaskChef's separate state file. Neither source modifies Codex's databases.
