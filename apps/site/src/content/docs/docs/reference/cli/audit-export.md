---
title: authtempo audit export
description: Write the audit rows of one organization to stdout as NDJSON or CSV, the oldest first, with the operator secret.
type: reference
sources:
  - packages/cli/src/commands/audit.ts
  - packages/cli/src/help/audit.ts
sidebar:
  order: 27
---

**For:** an operator or an auditor who keeps a copy of the audit of one organization, or gives it to the customer.

**What it does:** this page lists the flags of `authtempo audit export`, its two formats, and the route that it calls.

## Before you start

- The user tools on: `operator.users: true`, and a named secret with the `audit` scope in `operator.secrets`. [Configuration](/docs/reference/config/) lists the keys.
- The operator secret in `AUTHTEMPO_OPERATOR_SECRET`, or in a file. [Secrets](/docs/reference/cli/#secrets) gives the rule.
- A deployment at schema version 18 or later. [The organization audit](/docs/guides/organization-audit/) tells what a row holds.

## The command

The `@authtempo` packages are on npm. Add the CLI to your app with `pnpm add -D @authtempo/cli`, and run each command as `pnpm exec authtempo …`.

```sh
authtempo audit export https://api.example.com --organization 01J8Z3Q4R5S6T7V8W9X0Y1Z2A3 --format csv > audit.csv
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--organization <id>` | The id of the organization. The command needs it. |
| `--format ndjson`, `--format csv` | The format of stdout. The command needs it. |
| `--after <id>` | Start after this id. The cursor of the page before gives it. |
| `--limit <n>` | The rows of one page, from 1 to 100. The default is 100. |
| `--max-calls <n>` | The most calls of one run, from 1 to 10000. The default is 100. |
| `--token-env <NAME>` | The variable of the operator secret. The default is `AUTHTEMPO_OPERATOR_SECRET`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--token-file <path>` | The file of the operator secret. A dash reads stdin. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of each request, from 1 to 120. The default is 10. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The command wrote every row. |
| 1 | The read reached --max-calls with more rows. The command printed the rows that it read. |
| 2 | A usage error, or a stop. A stop names its cause: no answer, the tools are off, a refused secret, no audit scope, or the limit of 600 calls an hour. |

The command takes no `--json`, because stdout holds the export. Each run writes this line to stderr: `the organization audit starts at schema version 18; rows before it have no organization`.

The command reads each page until `next` is null, then writes the rows. At `--max-calls` it stops with a warning and exit 1, and writes the rows that it read. Give the last id as `--after` to read on.

An `invalid_body` stop with well-formed ids names the likely cause: a deployment before schema version 18. Its audit query has no `organizationId`.

## The formats

- `ndjson` writes one JSON object per line: the row of [`GET /operator/audit`](/docs/reference/routes/#get-operator-audit).
- `csv` writes one header line, then one record per row. The columns are `id`, `createdAt`, `actorKind`, `actorId`, `action`, `targetUserId`, `organizationId`, `reason`, `data`, `ip`, and `userAgent`. The `data` cell holds JSON text.
- A CSV cell that starts with `=`, `+`, `-`, `@`, a tab, or a carriage return starts with `'` (the OWASP rule). So a spreadsheet runs no formula.
- A CSV cell that holds a comma, a quote, or a line break is in quotes.
- Some spreadsheets use `;` as the list separator, for example in de-DE or fr-FR. They split the line at each `;`, also inside quotes. So a `'` also goes after each `;` and each line break in a cell, before a quote or the cell end. It goes there before each character of the OWASP rule too. Thus no field starts a formula, with `,` or `;` as the separator.

The export holds the operator view of each row: the actor kind and id, the reason, and the IP and user agent of each act. The organization audit of the owner shows less. Give the file only to a person who may see the operator data.

## The route

| Field | Value |
| --- | --- |
| Route | [`GET /operator/audit`](/docs/reference/routes/#get-operator-audit) |
| Header | `Authorization: Operator <secret>` |
| Query | `organizationId`, `after`, and `limit`. |
| Answer | `{ rows, next }`. |
| Limit | The key `operator-users:ip:<ip>`, a window of 1 hour, and 600 calls, right or wrong secret, shared with every command of the user tools. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`invalid_body`](/docs/reference/errors/#invalid_body), [`unauthorized`](/docs/reference/errors/#unauthorized), [`operator_required`](/docs/reference/errors/#operator_required), [`rate_limited`](/docs/reference/errors/#rate_limited) |

The export uses the operator secret. The owner route [`GET /organizations/audit`](/docs/reference/routes/#get-organizations-audit) needs the session of a user, and an organization token gets `unauthorized` there.

## Next

- [The organization audit](/docs/guides/organization-audit/)
- [authtempo audit list](/docs/reference/cli/audit-list/)
- [Routes](/docs/reference/routes/#operator-user-tools)
