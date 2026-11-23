---
title: Setup link reference
description: The config, the routes, the client calls, the notices, the hook, and the guides of the SSO setup link.
type: reference
sources:
  - packages/core/src/config.ts
  - packages/core/src/engine/sso/setup-links.ts
  - packages/core/src/engine/sso/expiry.ts
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

An organization holds at most 2 live links. A live link is not revoked, not ended, and not expired. The mint answers `setup_link_limit` past it. The calls of `sso.setupLinks` need a manager with a second factor on.

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
| [`GET /sso/:connectionId/start?test=1`](/docs/reference/routes/#get-sso-connectionid-start) | The setup session, or a manager. It starts a test sign-in of a draft. While `sso.setup` is off, the flag has no effect |
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

A notice is a mail. A failed mail writes one log line, and the change stays. An owner with no address gets no mail.

## The connection status

Each connection of [`GET /sso/connections`](/docs/reference/routes/#get-sso-connections) holds `status`. `api.sso.connections.list` answers the same `SsoConnectionStatus`.

| Field | What it holds |
| --- | --- |
| `lastSuccessAt` | The time of the last real sign-in that passed, or null. |
| `lastFailureAt` | The time of the last real sign-in that failed, or null. |
| `lastFailureStep` | The step of that failure, or null. |
| `certificateEndsAt` | The end of the SAML certificates: the latest `notAfter`. Null on an OIDC connection. |
| `expiryStage` | The last expiry notice that the sweep claimed: 30, 7, or 1. Null before the first notice. |

- Core writes `lastSuccessAt`, or `lastFailureAt` and `lastFailureStep`, at most once an hour for each field. A test run writes none of them.
- The write keeps `updatedAt`, so it does not change the lock of a manager update.
- A failed write never fails the sign-in. It emits `sso.status_write_failed` and writes the line `authtempo: sso status write failed`.
- A connection from before schema version 18 holds null in each field. Its first real sign-in after the upgrade fills the certificate end and the notice date.

## The expiry notices

The sweep tells the owners when an SSO credential ends soon. The step is `ssoExpiryNotices` of [the sweep](/docs/guides/sweep/). Without a scheduled sweep, no notice goes out.

| Kind | The end | The stages |
| --- | --- | --- |
| `saml_certificate` | The latest `notAfter` of the certificates of an enabled SAML connection | 30, 7, and 1 days |
| `scim_token` | `expiresAt` of a SCIM token. A token with no expiry gets no notice | 30, 7, and 1 days |
| `setup_link` | `expiresAt` of a live setup link. A link lives at most 168 hours | 1 day only |

For each stage of a row, the sweep does these steps in this order:

1. It claims the stage with one conditional write on the row. Of two sweeps at once, only one wins, so the owners get one notice.
2. It mails the `sso_expiring` notice to the owners: each member whose role holds the owner rank. At most 10 owners get a mail.
3. It emits the event `sso.expiring`.
4. It runs `hooks.sso.expiring({ organizationId, kind, id, at })`.

- A late sweep sends one notice for the smallest due stage, and skips the larger stages.
- The claim is the record. A failed mail writes `notice.mail_failed` with `sso_expiring`. No sweep sends that mail again.
- The owner read skips each member that holds exactly one role below the owner rank. It reads one page of 100 of the other members: the owners, the members with a comma list of roles, and the members with a dynamic role.
- The size of the organization does not cut the scan. Only more than 100 such members cut it. Then an owner past the page gets no mail, and the step writes `notice.mail_failed` with a `RangeError`.
- `ownersCut` of the event counts the owners past the 10 mails.
- With `account.notices` off, no mail goes out. The event and the hook still run.
- A write of new certificates starts the stages again from the new end.
- A draft gets no notice. Its notice date starts at the activation.
- A disabled connection gets no notice, and keeps its notice date. After an enable, the next sweep sends the nearest due stage.
- A revoked or ended setup link, and a row whose end is past, loses its notice date and gets no notice.
- `hooks.sso` needs `sso`. With `scim` alone, a SCIM token gets the mail and the event, and no hook.
- A row from before schema version 18 gets its dates at its next use. A SAML connection gets them at its next sign-in or certificate write. A SCIM token gets them at its next SCIM call. A setup link from before version 18 gets no notice.

Warning: a mail goes through your mail supplier, which can drop it. Do not use the mail as the only signal. Use `hooks.sso.expiring` or the event `sso.expiring` as the signal that you own. Send it to your own alert or ticket system.

## The events, the limits, and the errors

- The events are `sso.setup_opened` and `sso.setup_refused`. See [Events](/docs/reference/events/).
- The expiry events are `sso.expiring` and `sweep.sso_expiry_stopped`. The status event is `sso.status_write_failed`.
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
