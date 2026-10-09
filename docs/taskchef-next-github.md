# GitHub PR status in TaskChef Next

TaskChef reads PR attachments from `state_5.sqlite:thread_attachments`.
Only records with `attachment_type = pull_request` count. The `payload.url`
identifies the PR. Links mentioned in chat messages do not count as attachments.
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

| Chat / attached PRs | Column |
| --- | --- |
| Archived | Archived, if enabled |
| Latest turn in progress | Running |
| Failed or interrupted turn | Waiting, with Interrupted tag |
| Completed turn; every attached PR confirmed merged | Done |
| Completed turn; any open, draft, closed without merge, or unavailable PR | Waiting for input/review |
| No attached PR | Existing schedule and manual Done rules |

Mark Done is available for chats without attached PRs. A new turn resets that
mark. A passing CI badge means the reported checks passed; it does not guarantee
merge approval or that every branch-protection requirement is met.

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
