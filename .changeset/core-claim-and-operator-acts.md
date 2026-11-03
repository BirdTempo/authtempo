---
"@authtempo/core": patch
---

A flow that claims an unverified address counts its claim retries apart from its unique-key retry. Before, a magic link, a social sign-in, a password reset, or an invitation confirm could answer 500. That happened after one unique-key retry, two session races, and one lost claim.

A ban by a platform operator reads the platform role of its target again inside its transaction. So a grant of the role that commits after the first read makes the ban answer `operator_required`. A grant of the platform role now locks the organization before it counts `membersPerOrganization`. So two grants at the limit add one member row, not two.

On a store with a query limit per invocation, such as D1, the account delete reads the user's scimUser rows before its size check. It keeps one query for each chunk of 50 rows past the first. So a user with scimUser rows in more than 50 organizations deletes inside 50 queries.
