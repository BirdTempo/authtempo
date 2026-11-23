---
"@authtempo/cli": minor
---

Add the command `authtempo audit export <base url> --organization <id> --format ndjson|csv`. It reads each page of `GET /operator/audit` for one organization with the operator secret, up to `--max-calls`. It writes one row per line to stdout. A CSV file starts with a header line and uses RFC 4180 quotes. A CSV cell that starts with `=`, `+`, `-`, `@`, a tab, or a carriage return starts with `'`, so a spreadsheet runs no formula. A cell that holds a `;` is in quotes too, so a spreadsheet with `;` as its list separator does not split it. The command takes no `--json`, because stdout holds the export. The rows of `audit list --json` now hold `organizationId`. A deployment before schema version 18 answers no such key, and the CLI then gives null.
