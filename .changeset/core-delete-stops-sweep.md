---
"@authtempo/core": patch
---

On a storage whose user delete cascades, an account delete now records the impersonation sessions that the cascade ends. Each storage of the compatibility package is such a storage. Before, the cascade took the sessions past the page of the delete, and no `impersonation_stop` row recorded their end.

With the impersonation tool on, the delete reads the user's live impersonation sessions before its page. The pending-end row of the delete names those that the page does not end, with the time of the delete. The sweep writes their `impersonation_stop` rows from its next run, one storage call each, in pages inside its call budget. Each such row holds `endedAt` in `data`, the time of the delete. `operator.afterAction` gets each row after the commit of the sweep.

On a storage with no row lock, another flow can end such a session after the read of the delete. That flow writes the stop row. So the sweep first reads the user's stop rows from 5 s before the delete, at most the newest 200. That read is one storage call for each pending-end row with such sessions. The sweep writes no second row for a session that one of these rows names.

A delete of a user with more than 100 live impersonation sessions on such a storage answers 409 `delete_too_large`, and changes nothing.

The read of the delete costs one storage call, and the size check of the delete counts it. On the D1 storage of the compatibility package with the tool on, a secret with the scope `delete` now takes fewer organizations. The delete of a user with no solo organization and 4 organizations that the user owns with another owner answers `delete_too_large`. Before this change, and with the tool off, that delete fits.
