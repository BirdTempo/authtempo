---
"@authtempo/core": patch
---

An account delete now reads the owner recount of all organizations that the user owns with another owner in one statement. Before, it read the owners of each such organization in its own statement. On D1 each such organization now costs 2 queries of the 50 of one invocation, and the recount costs 1 query for all of them. So on D1 more such organizations fit one delete. A secret takes 1 solo organization and 4 such organizations. On the D1 storage of the compatibility package, a secret takes 5 with no solo organization. With the impersonation tool off, it takes 6. The limits of a platform operator do not change.
