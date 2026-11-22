---
title: Setup link reference
description: The config, the routes, the client calls, the notices, the hook, and the guides of the SSO setup link.
type: reference
sources:
  - packages/core/src/config.ts
  - packages/core/src/engine/sso/setup-links.ts
  - packages/core/src/sso/guides/index.ts
  - packages/client/src/client.ts
---

**For:** an app developer who turns on the setup links, or who writes the setup page of its own.

**What it does:** this page lists each part of the setup link in one place. Each route has its full entry on the routes page. The steps are in [Set up SSO with a setup link](/docs/guides/sso-setup-link/).

## Before you start

- A working config with [`sso` and `organizations`](/docs/reference/config/).
- Read [Set up SSO with a setup link](/docs/guides/sso-setup-link/) for the order of the steps.

## Config

| Option | Value | Rule |
| --- | --- | --- |
| `sso.setup` | `{ ttlHours?, page? }` or `false` | Off when absent or `false`. It needs `sso`, which needs `organizations`. |
| `sso.setup.ttlHours` | whole number, 1 to 168 | The default life of a link. The default is 72. A mint may name its own `ttlHours` in the same range. |
| `sso.setup.page` | function | Replaces the setup page of core. It takes the page input and returns HTML. |
| `account.notices` | boolean | `sso.setup` throws a `ConfigError` at start when this is `false`. An owner learns of a ready setup by a notice only. |

Any other key of `sso.setup` throws a `ConfigError`.

## Routes

The setup link routes exist only when `sso.setup` is on.

| Route | Who calls it |
| --- | --- |
| [`POST /sso/setup-links/create`](/docs/reference/routes/#post-sso-setup-links-create) | An owner, or a platform operator |
| [`GET /sso/setup-links/list`](/docs/reference/routes/#get-sso-setup-links-list) | An owner, or a platform operator |
| [`GET /sso/setup-links/get`](/docs/reference/routes/#get-sso-setup-links-get) | An owner, or a platform operator |
| [`POST /sso/setup-links/revoke`](/docs/reference/routes/#post-sso-setup-links-revoke) | An owner, or a platform operator |
| [`POST /sso/setup-links/activate`](/docs/reference/routes/#post-sso-setup-links-activate) | An owner, or a platform operator |
| [`GET /sso/setup`](/docs/reference/routes/#get-sso-setup) | The IT admin, with the link |
| [`POST /sso/setup/open`](/docs/reference/routes/#post-sso-setup-open) | The IT admin, with the link |
| [`POST /sso/setup/domains/add`](/docs/reference/routes/#post-sso-setup-domains-add) | The setup session |
| [`POST /sso/setup/domains/verify`](/docs/reference/routes/#post-sso-setup-domains-verify) | The setup session |
| [`POST /sso/setup/connection`](/docs/reference/routes/#post-sso-setup-connection) | The setup session |
| [`POST /sso/setup/scim-token`](/docs/reference/routes/#post-sso-setup-scim-token) | The setup session |
| [`POST /sso/setup/handback`](/docs/reference/routes/#post-sso-setup-handback) | The setup session |
| [`GET /sso/setup/status`](/docs/reference/routes/#get-sso-setup-status) | The setup session |

The setup session is the cookie `__Host-tempo_setup`. A bearer token or a normal session cookie does not open a setup route.

## The client calls

The calls of `sso.setupLinks` need a signed-in manager. The calls of `sso.setup` need the setup cookie, so make that client with no `token`. The full list is in [Client](/docs/reference/client/).

## The server API

The server API has no `setupLinks` call. A server holds no setup cookie and no manager session, so it calls the routes.

## The notices and the hook

| Name | When | To whom |
| --- | --- | --- |
| `sso_setup_ready` | After a handback | Every owner of the organization |
| `sso_activated` | After an activation | Every owner of the organization |
| `hooks.sso.setupReady({ organizationId, linkId })` | After the commit of a handback | Your code. A throw writes one log line, and the handback stays. |

## The events, the limits, and the errors

- The events are `sso.setup_opened` and `sso.setup_refused`. See [Events](/docs/reference/events/).
- Each limit has the key `setup-open`, `setup-page`, `setup-draft`, `setup-status`, or `setup-test`. See [Limits](/docs/reference/limits/).
- The codes `setup_link_invalid`, `setup_link_limit`, and `setup_not_tested` are in [Errors](/docs/reference/errors/).

## The provider guides

`GUIDES` of `@authtempo/core` holds one typed record for each provider: `okta`, `entra`, `google-workspace`, `generic-saml`, and `generic-oidc`. The setup page and the pages below read the same record. Each record has the date of its read, `checkedOn`. A step or a launch text may have an `unconfirmed` reason. The release check fails when a `checkedOn` is older than 180 days.

- [Okta](/docs/guides/sso-setup-idp-okta/)
- [Microsoft Entra ID](/docs/guides/sso-setup-idp-entra/)
- [Google Workspace](/docs/guides/sso-setup-idp-google-workspace/)
- [Generic SAML](/docs/guides/sso-setup-idp-generic-saml/)
- [Generic OIDC](/docs/guides/sso-setup-idp-generic-oidc/)

## Next

- [Set up SSO with a setup link](/docs/guides/sso-setup-link/)
- [Routes](/docs/reference/routes/)
