---
"@authtempo/core": minor
---

The token and role acts of an organization now write one audit row each, with the organization in the column `organizationId`. A token create writes `organization_token_create` with the token id, the hint, and the permissions, never the token or its hash. A token revoke writes `organization_token_revoke`. A role create, update, and delete write `organization_role_create`, `organization_role_update`, and `organization_role_delete`. The update row names the changed fields, never their values. A row of a route act holds the IP and the user agent of the request. The compat create `createOrganizationTokenFor` writes null for both. Each row commits in one transaction with its act. The token revoke and the role update now run in a transaction. On D1 the role update sends two more statements and each other act one more. A member removal with `revokeTokens` writes no token revoke row.
