---
"@authtempo/compat-better-auth": patch
---

`listUserAccounts` and `/list-accounts` skip the pending identity row of an import, whose provider is `pending$<provider>`. `unlinkAccount` answers `ACCOUNT_NOT_FOUND` for such a row. The import writes the row under its hold and makes it live after its last check.
