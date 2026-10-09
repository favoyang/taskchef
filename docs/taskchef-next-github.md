# GitHub PR status in TaskChef

TaskChef reads PR attachments from `state_5.sqlite:thread_attachments`.
Only records with `attachment_type = pull_request` count. The `payload.url`
identifies the PR. A transcript link alone does not establish PR ownership. The card uses only registered PRs referenced in the latest prompt/reply or successfully attached by a saved `codex_app.attach_artifact` call in that turn. Older chat attachments do not decide the latest turn's state.
Older Codex databases without this table show no PR attachments.

## Connect GitHub

1. Open TaskChef's plugin settings and set the public GitHub App client ID.
2. Select the GitHub icon in the board header, then **Sign in with GitHub**.
3. Enter the displayed code on GitHub and approve access.
4. Install the GitHub App on the accounts and repositories you want to read.
   **Repository access** opens GitHub's installation settings.

The public client ID is not a secret. The device code, access token, and refresh
token stay in the local MCP server's system credential store. They never go to
the sidebar, ordinary JSON files, shell arguments, or a TaskChef hosted server.
On macOS this is Keychain; Windows uses Credential Manager; Linux requires
Secret Service. Release packaging includes credential-store bindings for macOS and Windows on
ARM64/x64, and Linux on ARM64/x64 with glibc or musl. There is no plaintext fallback. A locked or unavailable store
shows an error. GitHub's own approval and repository-selection pages control
access. Organizations may require administrator approval.

**Disconnect this computer** removes the local credential and clears the
process's PR cache. It does not revoke the GitHub grant. Revoke that separately
in GitHub's authorized-app settings if desired.

## Register the app

Register a GitHub App, enable **Device flow**, and keep expiring user access
tokens enabled. Disable webhooks. Request these repository permissions:

| Permission | Access | Purpose |
| --- | --- | --- |
| Pull requests | Read-only | Open, draft, closed, and merged PRs |
| Checks | Read-only | CI check results |
| Commit statuses | Read-only | Older CI status results |
| Metadata | Read-only | Required by GitHub |

Use the project repository as the homepage. Device flow needs no callback
server, private key, or client secret. GitHub requires the app to be installed
for private repository access. Choose **Any account** if distributing it to
other users. Registration does not itself give the app access to repositories.

The preview supports GitHub.com only. Enterprise hosts show an unavailable
status. Do not enter an OAuth App ID or a personal access token in the setting.

## Board rules

Archived chats go to the optional Archived column before these rules apply.
Chats with no saved turn are hidden. Running always takes priority over Done marks.

### With an active schedule

| Latest turn | Result | Column |
| --- | --- | --- |
| Either input source | In progress | Running |
| Either input source | Failed or interrupted | Waiting, with Interrupted tag |
| Scheduled prompt | Completed, with any PR state or no PR | Scheduled |
| Human prompt | Completed; all latest-turn PRs merged | Scheduled |
| Human prompt | Completed; unmerged/unknown PR or no PR | Waiting for input/review |

A saved heartbeat marker identifies a scheduled prompt. If input source cannot
be verified, use the human-input rules. Any active schedule keeps the chat
scheduled, even when the schedule that started the latest turn is now paused.
Manual Done is disabled until all schedules are paused.

### Without an active schedule

| Latest turn / user action | Column |
| --- | --- |
| In progress | Running |
| Marked Done for this turn, with no latest-turn PR | Done |
| Failed or interrupted, without a Done mark | Waiting, with Interrupted tag |
| Completed; all latest-turn PRs merged | Done |
| Completed; any unmerged or unknown latest-turn PR | Waiting for input/review |
| Completed; no latest-turn PR and no Done mark | Waiting for input/review |
| Unrecognized saved turn status | Unverified, within Waiting |

A new turn resets a manual Done mark. Passing CI does not guarantee merge
approval or that every branch-protection requirement is met. A closed PR
without merge remains Waiting for a human.

Badges show Merged (purple), Draft (gray), Checks passed (green), No checks or
Checks pending (yellow), Checks failed or Closed without merge (red), and
Unavailable (gray). Hover shows the PR URL, check time, and any access error.

## Refresh and failure behavior

The board still polls its local MCP server every five seconds while visible.
GitHub status is cached in memory for 60 seconds per MCP server. Queries combine
up to 25 PRs in one request per poll. Additional PRs are checked on later polls. Hidden CLI/exec chats and archived history do not
start GitHub requests. A forced board refresh bypasses this cache, but still respects GitHub rate limits.

GitHub receives repository names and PR numbers only, plus its authentication
token. Task titles, prompts, replies, and local paths are not included.

Unavailable status never counts as merged. A failed refresh replaces the cached
status with Unavailable. Codex database failures remain fatal to the board;
GitHub failures are shown in the connection dialog and PR badges.

Device sign-in polls only while its dialog is open and visible. It follows
GitHub's polling interval and slows down when requested. Pending sign-in is
stored in the credential store so another local MCP process can continue it.
Refresh tokens are rotated under a local lock shared by MCP processes.

## References

- [GitHub App device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refresh user tokens without a device-flow client secret](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [GitHub App permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
