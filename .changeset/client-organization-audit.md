---
"@authtempo/client": minor
---

Add `client.organizations.audit.list` and `client.organizations.audit.export`. The list reads one page of `GET /organizations/audit` and answers `{ rows, next }`. Pass `next` as `after` to read the page after it. A 200 with no list of `rows`, or with no `next`, answers `unexpected` with status 200. The export is an async iterator over every row of the query. It reads one page of 100 rows for each request and holds one page at a time. A caller that stops early sends no more requests. A failed page throws its `ClientFailure` after the rows of the pages before it. A 200 that is not a page throws `unexpected` with status 200, so a missing `next` cannot end an export early with no failure. The new types are `OrganizationAuditView` and `OrganizationAuditQuery`.

`client.sso.connections.list` now answers `SsoConnectionListedJSON[]`: each connection with its `status`, as `GET /sso/connections` answers it. `SsoConnectionListedJSON` is `SsoConnectionJSON` with `status`, so code that types a listed connection as `SsoConnectionJSON` still compiles.
