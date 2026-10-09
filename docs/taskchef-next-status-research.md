# TaskChef Next status research

> Research note, not a product contract. See [the specification](spec.md) for
> current TaskChef behavior and [the sidebar guide](mcp-app.md) for the current
> TaskChef Next implementation.

## Local data and proposed labels

TaskChef Next can read chat metadata from `state_5.sqlite:threads` and the
latest turn from `thread_history_1.sqlite:thread_turns`. A turn's `completed`
status means Codex ended that turn. It does not say whether the user's larger
task is finished or whether the assistant asked for input. The sidebar now applies the workflow rules described in [the sidebar guide](mcp-app.md).

The proposed board labels are workflow rules, not semantic judgments:

| Label | Proposed rule |
| --- | --- |
| Running | Open chat; latest selected turn is `inProgress`, regardless of timestamp age. |
| Waiting for input/review | Open chat; latest turn is `completed`. This includes ordinary idle chats, even when no question or review was requested. |
| Done | User marks a chat without PRs done, or its latest turn completed and all attached PRs are confirmed merged. A new turn clears a manual Done mark. |
| Archived | Chat is archived. Hidden by default and shown in a separate column when enabled. |
| Interrupted | Open chat; latest turn is `interrupted` or `failed`. Show the recorded error when available. |

These labels describe the **board queue**, not verified task outcomes. Waiting
means the chat is open and Codex is idle; it does not prove that Codex requested
input or review. Done means a manual mark for a chat without PRs, or confirmed merged status for all attached PRs.
Archived is separate; archiving does not prove that the underlying work succeeded.
The GitHub integration uses merged PRs for Done and unmerged or unavailable PRs
for Waiting after a completed turn. Real sign-in needs a registered GitHub App.

The archive flag takes precedence over an old turn status. The earlier proposal
used a two-minute activity cutoff for Running. That proposal is superseded:
the sidebar follows the latest selected turn status and does not infer a stop
from timestamp age. Unrecognized turn states remain Unverified. Chats with no
turn row are omitted. The sidebar excludes JSON subagent sources in
`threads.source` and includes all eligible chats with a current-rollout turn.

Counts from all unarchived database rows are not counts of current work. The
optional Updated filter narrows the view; it does not change queue labels.

## Scheduled work

An active schedule is a flag on a chat, alongside its current workflow label.
The board has a Scheduled column for idle scheduled turns. Running and
Interrupted take precedence; ordinary completed input returns to Waiting while
the schedule badge remains.

Local heartbeat configurations have `target_thread_id` and `status`. The latest
turn points through `first_user_item_id` to `thread_items.item_json`. Observed
heartbeat inputs contain a `<heartbeat>` wrapper with an `automation_id` and
have no `clientId`; ordinary desktop inputs have a `clientId`. The sidebar
matches the wrapper to a known automation on that chat rather than matching
execution time. This is an observed internal format, not a supported stable API.
It does not infer scheduled origin from a missing `clientId` alone. Paused
schedules do not place idle chats in Scheduled. Cron runs are distinct from
heartbeat chats and are not linked by this rule.

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

## Cloud and GitHub prerequisites

The local scanner does not contain durable-host cloud chats. A read-only test
of `codex cloud list --json --limit 20` returned an empty task list, while the
desktop thread tools had returned five durable-host chats. This does not prove
that all cloud accounts behave the same way. It does show that this command
cannot supply the missing chats in the tested account. Do not replace the
missing cloud list with an empty list presented as complete. A supported
code-driven source for these desktop cloud chats is still needed.

The current Codex database has `state_5.sqlite:thread_attachments`. Records with
`attachment_type=pull_request` provide the attached PR URL in `payload.url`.
This corrects the earlier schema scan. Transcript links are not attachments.

The implemented GitHub App device flow needs a registered public client ID and
device flow enabled. Registration currently waits for owner identity confirmation.
TaskChef uses read-only Pull requests, Checks, and Commit statuses permissions.
Access and refresh tokens stay in the local OS credential store; the sidebar
receives no tokens. There is no client secret, private key, or developer CLI
credential in the product flow.

After a completed turn, a nonempty attachment list with every PR confirmed merged
means Done. Open, draft, closed without merge, and unavailable PRs stay Waiting.
Running, Interrupted, and Archived retain their rules. Manual Done applies only
without PR attachments. See [setup, polling and validation limits](taskchef-next-github.md).
