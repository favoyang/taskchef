# Directory submission preparation

Researched 12 October 2026. Status: prepared for review, blocked on a supported
local MCP distribution route. This is not an approved directory submission.

## Eligibility

TaskChef 9 uses a bundled Node process over stdio. It reads the user's local
Codex SQLite databases and session files. It has no hosted MCP endpoint or
TaskChef account service. Hosting the current server remotely would remove
access to the data the dashboard needs.

The [packaging guide](https://developers.openai.com/plugins/build/plugins)
requires a remote HTTPS MCP endpoint for the public submission route and directs
local MCP developers to their OpenAI contact. The
[conversion guide](https://developers.openai.com/plugins/guides/submit-claude-plugin)
says core local execution/file access needs product-specific consultation.
Therefore eligibility for the full local dashboard is **not established**;
the documented self-service route does not accept its current transport.

Keep the existing Codex marketplace installation. The owner selected Favo Yang
as the personal publisher and instructed us not to contact OpenAI directly.
No outreach is planned. Reassess if the published local-distribution rules change. A skills-only listing would distribute delegation, not
the dashboard; do not present it as the complete product. Do not build a remote
bridge or upload private chat databases merely to fit the submission form.

## Publisher

The directory uses the verified developer identity. Individual verification
supports a personal name; business verification supports a company name.
See [review prerequisites](https://developers.openai.com/plugins/deploy/app-review).
The owner selected Favo Yang. Individual verification is still required; it has
not been checked or completed here. This decision does not resolve the
transport blocker. A Platform account, organization and project own the draft.

## Readiness checklist

- [ ] OpenAI confirms an eligible local MCP route and review environment.
- [x] Owner selects Favo Yang as personal publisher.
- [ ] Individual verification and Apps Management Write access are confirmed.
- [ ] taskchef.dev, support, privacy and terms URLs are public, accurate, and
      identify the chosen operator.
- [ ] Listing copy and icons pass directory limits and package validation.
- [ ] Included delegate skill passes required skill safety/security scans.
- [ ] Reviewers can exercise the native dashboard with synthetic local data.
- [ ] Record a reviewer-accessible walkthrough; no private chats or credentials.
- [ ] Execute the five positive and three negative cases in review-cases.json
      using the approved host; record actual outcomes and platform coverage.
- [ ] Complete setup/domain verification and current tool scan if OpenAI's
      approved route requires a remote endpoint.
- [ ] Upload only the supported package, resolve findings, submit for review.
- [ ] Publish only after approval and owner authorization.

The [submission guide](https://developers.openai.com/plugins/deploy/submission)
requires a ZIP, verified identity, completed scans and review information. An
initial MCP review requires exactly five positive and three negative cases,
a demo recording, and release notes. Reviewer access belongs in the secure
portal, never the ZIP. Metadata and skill updates require a new ZIP.

No upload-ready ZIP is produced here: creating one with a fake HTTP endpoint,
removing the MCP server, or claiming ChatGPT/mobile support would misrepresent
TaskChef. The listing and cases are drafts pending a supported local route.

## Package audit

Current manifest: .codex-plugin/plugin.json; transport: .mcp.json.
The current short description exceeds the directory's 30-character limit;
the draft uses “Your Codex chats in one place”. Support/privacy/terms URLs
are currently absent. The draft proposes taskchef.dev URLs after publication.
Some settings tools lack nonempty descriptions in src/mcp-app.js; audit those
against the [tool metadata guidelines](https://developers.openai.com/plugins/plugin-guidelines)
before review. Several dashboard tools are UI-only, so their review cases must
use board interactions rather than claim they are model-callable. The current
plugin has one delegate skill and no lifecycle hooks or app references. Keep TaskChef Dev identity out of any release submission.

The [validation reference](https://developers.openai.com/plugins/deploy/submission-errors)
sets the listing limits, asset requirements, required remote URLs and tool scan.
Changing metadata cannot make a local stdio endpoint remotely accessible.

## Current delivery boundary

No OpenAI inquiry, signup, verification, upload, submission or publication is
performed. Keep website drafts and review cases ready for a supported route.
Do not submit the delegate skill alone under a dashboard listing: adding an MCP
server to a skills-only listing is not currently supported, and the skill does
not provide the advertised dashboard.
