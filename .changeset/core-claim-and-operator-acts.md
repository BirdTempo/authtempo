---
"@authtempo/core": patch
---

A flow that claims an unverified address counts its claim retries apart from its unique-key retry. Before, a magic link, a social sign-in, a password reset, or an invitation confirm could answer 500. That happened after one unique-key retry, two session races, and one lost claim.

On a store with a query limit per invocation, such as D1, a claim runs once. When another proof claims the user first, the flow answers 409 `conflict`, and the undo leaves no write of the claim. The reset and the invitation confirm keep their link, so the client can send the same request again. Before, one session race on D1 could pass 50 queries, answer 500, and keep writes of the claim.

A ban by a platform operator reads the platform role of its target again inside its transaction. A grant of the platform role now locks the organization before it counts `membersPerOrganization`. On a store that locks rows, such as Postgres and MySQL, these steps close two races. A grant that commits after the first read of the ban makes the ban answer `operator_required`. Two grants at the limit add one member row, not two. D1 and the SQLite adapter have no row lock, so there the second read and the lock do not close these races. On D1 the tests check only the query count of each act.

On a store with a query limit per invocation, such as D1, the account delete reads the user's scimUser rows before its size check. It keeps one query for each chunk of 50 rows past the first. So a user with scimUser rows in more than 50 organizations can delete inside 50 queries. A delete whose chunks do not fit the budget answers `delete_too_large` before any delete.

The size check of an account delete now counts each read that it sends. Before, it counted 3 reads of the organization rule, but a user with 51 to 100 memberships costs 5. So such a delete on D1 could pass the 50 calls of one invocation.
