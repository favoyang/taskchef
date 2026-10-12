# MagicPath onboarding research

Researched 12 October 2026. No account was created, disconnected or modified.
The user's reported first-install signup was not independently replayed.

## Evidence

The [directory listing](https://chatgpt.com/plugins/magicpath) presents three
starter prompts and a design/canvas service. Its locally installed 2.0.0
package contains a skill and a required registered remote integration. The
installed manifest has no onboardingSkill field. This snapshot does not prove
what every historic version or portal configuration used.

MagicPath's [FAQ](https://www.magicpath.ai/documentation/help/faq) says users
install the plugin and sign in with their MagicPath account in a browser,
without pasting an API key. Projects are cloud-hosted and external agents can
work while the website is closed.

Public metadata was fetched directly, without credentials:

- [Protected resource metadata](https://api.magicpath.ai/.well-known/oauth-protected-resource/mcp/openai/v1):
  resource https://api.magicpath.ai/mcp/openai/v1; authorization server
  https://api.magicpath.ai/; scopes magicpath:read and magicpath:write.
- [Authorization metadata](https://api.magicpath.ai/.well-known/oauth-authorization-server):
  /authorize, /token, /register; S256 PKCE support.

This supports an OAuth account-connection explanation for the reported login.
It does not establish the exact screen order, signup fields, session reuse,
or whether signup is mandatory for an existing account.

## Two separate mechanisms

[OpenAI authentication](https://developers.openai.com/plugins/build/auth)
describes account authorization and tokens for protected MCP requests. The
provider can present login/signup while authenticating the user.

An [onboarding skill](https://developers.openai.com/plugins/build/plugins)
is an optional setup conversation selected by onboardingSkill. It runs when
users start setup, in a new or existing conversation. It is not the OAuth
credential exchange and does not itself create a provider account.

## What TaskChef can learn

Give users a clear next action after install: open the native board, inspect
one chat, then optionally connect GitHub for live PR status. Keep native
project delegation accessible through a concrete starter prompt.

Show why a connection is needed before asking for it. MagicPath needs an
account to identify cloud projects; TaskChef's local dashboard can identify
local chats without a TaskChef account. GitHub authentication remains optional.

Use outcome-based listing prompts, accurate privacy links and minimal setup.
Do not add signup for marketing, tracking, or to imitate a cloud product.
A future hosted TaskChef service could need account authorization, but that is
outside this preparation. Adding a setup skill is a separate product change;
it is not implemented by this research.
