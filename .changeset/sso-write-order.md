---
"@authtempo/core": minor
"@authtempo/client": minor
"@authtempo/compat-better-auth": minor
---

The two SSO connection writes name their row in the query. `POST /sso/connections/create` takes `organizationId` in its query, and `POST /sso/connections/update` takes `id` in its query. The body holds the other fields, and a body that carries the id answers `invalid_body`. So the manager guard runs before the body read. An account that manages no organization reads no large body: it answers 403 before any byte. The client sends the query for you, so `sso.connections.create` and `sso.connections.update` keep their inputs. The compatibility package runs the same guard before its own read of these two paths. Before it reads `/sso/register` or `/sso/update-provider`, it checks that the caller can manage some organization.
