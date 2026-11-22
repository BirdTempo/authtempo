---
"@authtempo/core": minor
"@authtempo/client": minor
---

Add the SSO setup link. An owner of an organization mints a link and sends it to the IT admin of a customer. The IT admin opens it and fills in drafts: a domain, a connection, and a SCIM token. A test sign-in must pass for the current draft. The IT admin hands back, and the owner reads the preview and activates. Nothing goes live before the activation. The activation sends the `version` of the preview that the owner read, and answers `conflict` when the draft changed after that read. The sweep deletes the setup links, setup sessions, and test runs 30 days after they ended, and counts them in `ssoSetupRows`.

It is off by default. Turn it on with `sso: { setup: {} }`. It needs `sso` and `organizations`. It throws a `ConfigError` at start when `account.notices` is `false`, because the owners learn of a ready setup by a notice. `ttlHours` sets the life of a link from 1 to 168 hours, and the default is 72. `page` replaces the setup page of core. The hook `hooks.sso.setupReady` runs after each handback.

The new routes are `POST /sso/setup-links/create`, `GET /sso/setup-links/list`, `GET /sso/setup-links/get`, `POST /sso/setup-links/revoke`, `POST /sso/setup-links/activate`, `GET /sso/setup`, `POST /sso/setup/open`, `POST /sso/setup/domains/add`, `POST /sso/setup/domains/verify`, `POST /sso/setup/connection`, `POST /sso/setup/scim-token`, `POST /sso/setup/handback`, and `GET /sso/setup/status`. The new codes are `setup_link_invalid`, `setup_link_limit`, and `setup_not_tested`. The new notices are `sso_setup_ready` and `sso_activated`. `GUIDES` holds one typed guide for each of Okta, Entra ID, Google Workspace, generic SAML, and generic OIDC. The client has `sso.setupLinks` and `sso.setup`.

No guide was checked on a real tenant. Each guide shows the date of its read, and a label that the docs do not confirm shows as unconfirmed.

One risk stays. A person who steals a link before the IT admin uses it can fill a draft that names the provider of the thief. If the owner activates it after a quick read of the preview, the thief can sign in. Every owner gets the notice of a ready setup. Read the preview, and ask the IT admin by a second channel before you activate.
