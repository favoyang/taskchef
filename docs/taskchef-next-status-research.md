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
| Done | User explicitly marks the chat done. A new turn clears a manual Done mark. |
| Archived | Chat is archived. Hidden by default and shown in a separate column when enabled. |
| Interrupted | Open chat; latest turn is `interrupted` or `failed`. Show the recorded error when available. |

These labels describe the **board queue**, not verified task outcomes. Waiting
means the chat is open and Codex is idle; it does not prove that Codex requested
input or review. Done currently means the user marked the chat Done in TaskChef Next.
Archived is separate; archiving does not prove that the underlying work succeeded.
A future GitHub integration can use merged PRs for Done, and unmerged PRs for
Waiting after a completed turn. This policy is not yet implemented.

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

No PR association table was found in the inspected local `state_5.sqlite` or
`thread_history_1.sqlite` schema. Do not infer an attached PR from every GitHub
URL in a chat: an example or dependency can belong to another task. A verified
chat-to-PR attachment source is needed before PR merge state can label a chat.

For a local product, GitHub's device authorization flow is a possible OAuth
route. It requires a registered app's public client ID and device flow enabled
on that app. No TaskChef client ID has been supplied for this experiment.
Do not bundle a client secret, use the developer's private CLI credentials, or
borrow Codex's GitHub plugin credentials. Keep granted tokens in the local OS
credential store and out of the sidebar and ordinary settings files. See
[GitHub device flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

Once the attachment source and authentication are available, apply PR rules
only after a turn completes. Require a nonempty attachment list and confirmed
merged status for every attached PR before assigning Done. An open, draft, or
closed-without-merge PR stays Waiting. An unreadable or unavailable PR status
must not count as merged. Running, Interrupted, Archived, and manual Done
retain their existing rules. These PR rules are a proposed contract, not a
working integration.
