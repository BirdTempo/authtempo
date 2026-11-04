---
"@authtempo/core": patch
---

On a storage whose user delete cascades, an account delete now records the impersonation sessions that the cascade ends. Each storage of the compatibility package is such a storage. Before, the cascade took the sessions past the page of the delete, and no `impersonation_stop` row recorded their end.

With the impersonation tool on, the delete reads the user's live impersonation sessions before its page. The pending-end row of the delete names those that the page does not end, with the time of the delete. The sweep writes their `impersonation_stop` rows from its next run, one storage call each, in pages inside its call budget. Each such row holds `endedAt` in `data`, the time of the delete. `operator.afterAction` gets each row after the commit of the sweep.

A delete of a user with more than 100 live impersonation sessions on such a storage answers 409 `delete_too_large`, and changes nothing.
