---
"@authtempo/import": patch
---

The password row of a new unverified user is now pending until the import activates it, after its other writes, as in a repair. A sign-in with it fails until then. A run that stops after that pending create leaves the row, and a later run counts it as missing. The record is then `partial`, and a repair writes the password again.

On D1 the import of a new unverified user with a password sends two more queries, the activation.
