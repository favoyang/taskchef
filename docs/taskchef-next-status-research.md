# TaskChef Next status research

> Research note, not a product contract. See [the specification](spec.md) for
> current TaskChef behavior and [the sidebar guide](mcp-app.md) for the current
> TaskChef Next implementation.

## Local data and proposed labels

TaskChef Next can read chat metadata from `state_5.sqlite:threads` and the
latest turn from `thread_history_1.sqlite:thread_turns`. A turn's `completed`
status means Codex ended that turn. It does not say whether the user's larger
task is finished or whether the assistant asked for input. The current sidebar
therefore leaves most chats unresolved.

The proposed board labels are workflow rules, not semantic judgments:

| Label | Proposed rule |
| --- | --- |
| Running | Open chat; latest turn is `inProgress` with recent activity. |
| Waiting for input/review | Open chat; latest turn is `completed`. This includes ordinary idle chats, even when no question or review was requested. |
| Done | Chat is archived, or the user explicitly marks it done. A new turn should clear a manual Done mark. |
| Interrupted | Open chat; latest turn is `interrupted` or `failed`. Show the recorded error when available. |

These labels describe the **board queue**, not verified task outcomes. Waiting
means the chat is open and Codex is idle; it does not prove that Codex requested
input or review. Done means the user closed or archived the chat for this board;
archiving does not prove that the underlying work succeeded. Keep the archive
reason visible so a reader can tell it from an explicit Done mark.

The archive flag takes precedence over an old turn status. A stale
`inProgress` row in an **open** chat is not proof that the chat is Done or that
it is still Running; it needs a separate unverified treatment until the live
state is confirmed. Chats with no turn row should be omitted from this board
rather than given a workflow label. **Known current limitation:** the sidebar
filters `threads.thread_source` and `thread_spawn_edges`, but some review
subagents are identified only in `threads.source`. Those can still appear in
the current top-level inventory and count. Future source filtering must exclude
them before applying the chat limit.

Counts from all unarchived database rows are not counts of current work. The
board needs an explicit recency filter and should state the time window used.

## Scheduled work

An active schedule is best represented as a **flag** on a chat, alongside its
current workflow label. A scheduled run can be Running, Waiting after a normal
turn, or Interrupted after a failure. The user may also talk or code in the
same chat. A separate Scheduled state would hide that current condition.
The board can offer a Scheduled filter or group idle scheduled chats together
without discarding their underlying turn status. It should keep scheduled
failures visible as Interrupted.

For local heartbeat automations, an `automation.toml` file has a
`target_thread_id` and `status`. These fields can link an active schedule to
its chat. A paused schedule should not get the active Scheduled flag. A cron
automation may create a new chat for each run, so its schedule belongs to the
automation rather than automatically to every historical run. This mapping
still needs implementation and validation before the sidebar shows the flag.
`thread_turns` does not record whether a turn was started by a person or by a
schedule, so a completed turn in a scheduled chat cannot safely be called
"waiting for human input" from that table alone.

## Optional model judgment

A local Codex app-server client can reuse the desktop user's saved Codex login.
The experiment used `gpt-6-luna` with reasoning effort `none`: it started an
ephemeral, read-only app-server thread and sent a `turn/start` request with an
`outputSchema` requiring `state`, `confidence`, `evidence`, and `reason`. The
`state` values were `done`, `needs_input`, and `unknown`. The request included
real chat messages selected from `thread_history_1.sqlite:thread_items` and
received a schema-conforming JSON decision without an `OPENAI_API_KEY`. This
proves the route is possible, not that its judgments are accurate. The
app-server adds substantial context and latency, and the experiment did not
establish accuracy
across different chat types. Keep this as an optional enrichment route; it is
not needed to compute the proposed workflow labels. A separate Jev experiment
also returned a typed decision, but it needs separate TypeSafe credentials.

If semantic judgment is later added, compare it with independent human labels
and retain the evidence used for each decision. Do not silently convert a
model's guess into a database fact.
