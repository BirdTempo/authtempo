---
"@authtempo/core": minor
---

The member and invitation acts of an organization now write one audit row each. The acts are a member add, a role change, a member remove or leave, and an invitation create, accept, or revoke. Each row names its organization and holds the IP and the user agent of the request. A row holds no email address. A member remove with `revokeTokens` holds the count of the revoked tokens in `data.revokedTokens` and writes no token revoke row. A refused act writes no row. If the audit insert fails, the act does not occur. A SCIM add and an SSO sign-in that adds a member write no member row. `revokeInvitation` now deletes the invitation and writes its row in one transaction.
