---
"@authtempo/core": minor
---

Move the schema to version 18. The audit table gets the column `organizationId` and an index on `organizationId` and `id`. The SSO connection gets `certificateEndsAt`, `expiryStage`, `expiryNoticeAt`, `lastSuccessAt`, `lastFailureAt`, and `lastFailureStep`. The SCIM token and the setup link get `expiryStage` and `expiryNoticeAt`. Each of these three tables gets an index on `expiryNoticeAt`. Each new column is nullable, so an old row stays valid.

Add the names of the organization audit. The core resource `audit` has the action `read`. With the `ranks` form, only `owner` holds it. With the `roles` form, a role holds it only when the app lists it. An app statement named `audit` now throws a `ConfigError`. There are 12 new audit actions: 11 acts of an organization and `sso_setup_link_ready`. The route `GET /organizations/audit` has its contract. No module serves it yet. The operator audit row now names `organizationId`.

Add the names of the expiry notices: the hook `hooks.sso.expiring`, the notice `sso_expiring`, and the events `sso.expiring` and `sweep.sso_expiry_stopped`. Nothing sends them yet.
