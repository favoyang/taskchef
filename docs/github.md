# GitHub connection

GitHub sign-in is optional. Connect it to show PR and CI status and confirm
merge-based Done placement on the [Board](dashboard.md).

## Connect and manage access

1. Open TaskChef Settings and choose **GitHub → Connect GitHub**, then
   **Sign in with GitHub**. The Done column also links to these controls.
2. Enter the displayed device code on GitHub and approve access.
3. Install the TaskChef GitHub App on the accounts and repositories you want
   to read. **Repository access** opens GitHub's installation settings.

Once connected, Settings shows **Manage GitHub**. You do not need to register
your own GitHub App or supply a token. Organizations may require administrator
approval. TaskChef supports GitHub.com; Enterprise hosts show unavailable status.

TaskChef requests read-only Pull requests, Checks, Commit statuses, and Metadata
permissions. Tokens stay in the system credential store: Keychain on macOS,
Credential Manager on Windows, or Secret Service on Linux. There is no plaintext
fallback. Unlock or make that store available if sign-in reports a store error.

**Disconnect this computer** removes the local credential and clears cached PR
results. It does not revoke the GitHub grant. To revoke it, use GitHub's
[application settings](https://github.com/settings/apps).

## Understand PR status

TaskChef uses PRs attached to the Codex chat and associated with its selected
turn. A plain transcript URL alone does not establish an attachment. Ask Codex
to attach a missing PR. All latest-turn PRs must be confirmed merged for automatic
Done placement after a completed turn with no active schedule. Unknown or closed
unmerged PRs keep the chat waiting. Passing CI does not prove review approval or
that all branch protections are satisfied.

An earlier-turn PR may appear on a card when the latest turn has none. Its
**Earlier turn PR** label distinguishes it; it does not control Done placement.
Details can show PRs from other recorded turns.

Visible cards trigger GitHub reads; offscreen cards do not start checks.
Pending or unknown states retry while visible. Settled results stay cached, so
use **Refresh** after a merge or check change made on GitHub. Refresh also
updates the open Details panel. Rate limits still apply.

A repository warning can mean missing installation access. **Grant access**
opens the TaskChef App installation page. A missing PR can also mean it was
removed; network or rate-limit failures do not establish an access denial.
If CI cannot be read, valid PR state can still appear. Unavailable status never
counts as merged.

GitHub requests include repository names, PR numbers, revision identifiers and
authentication. They do not include chat prompts, replies, titles, or local paths.
See [privacy](https://taskchef.dev/privacy/) and [support](https://taskchef.dev/support/).
