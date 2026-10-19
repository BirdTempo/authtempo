---
title: authtempo secret rewrap
description: Reseal the rows of the old app secret versions under the current version through the operator route, call after call.
type: reference
sources:
  - packages/cli/src/commands/secret.ts
  - packages/cli/src/help/secret.ts
  - docs/superpowers/plans/2026-10-14-11c2-cli-additions.md "Task 4"
sidebar:
  order: 10
---

**For:** an operator who changes the app secret and wants the old rows moved to the new version, with no sign-in of each user.

**What it does:** this page lists the flags of `authtempo secret rewrap`, its JSON document, the stop rules of its loop, and its operator route.

## Before you start

- The operator routes on, with `operator: { secretHash }` in the config. [Configuration](/docs/reference/config/) lists the key. Core serves the route since plan 11c2.
- The new version current on every instance: step 4 of [Secrets](/docs/operations/secrets/). A rewrap before that step moves nothing.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo secret rewrap https://api.example.com --yes
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--limit <n>` | The rows of one call, from 1 to 1000. The default is 100. |
| `--max-calls <n>` | The most calls of one run, from 1 to 10000. The default is 100. |
| `--token-env <NAME>` | The variable of the operator secret. The default is `AUTHTEMPO_OPERATOR_SECRET`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--token-file <path>` | The file of the operator secret. A dash reads stdin, and then the command needs `--yes`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of each request, from 1 to 120. The default is 10. |
| `--yes` | Reseals with no question. A run with no terminal needs it. |
| `--no-input` | Never ask a question. Without `--yes`, the command then stops. |
| `--json` | Prints the document of [The JSON](#the-json). `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | No row of a configured old version remains. |
| 1 | A row did not open, or rows remain after the last call. A person must look. |
| 2 | A usage error, or a stop: no answer, the route is off, the deployment refused the secret, or the limit of calls. |

Each call prints one line on stderr: `call <i>: resealed <n>, failed <n>, skipped <n>, more <true|false>`. The sums go to stdout at the end: `calls <n>, resealed <n>, failed <n>, skipped <n>, more <true|false>`.

## The loop

Each call reseals up to `--limit` rows after the cursor of the call before. The command sends the `next` of each answer back as `after`, so a row that fails or is skipped blocks no row behind it. The loop ends at the first of three events:

1. The answer has `more: false`. No row of a configured old version remains. The command exits 0.
2. The answer has `next: null`. The pass read every row that was left. Some rows stay: a row that did not open, or a live setup with codes. The command exits 1 and names the reason.
3. The calls reach `--max-calls`. The command exits 1 and tells you to run it again.

A live setup is a TOTP setup that holds backup codes and is under 15 minutes old. The pass skips it, and a later pass moves it. Wait 15 minutes, then run the command again.

A row that did not open counts in `failed`. The log of the deployment names it. Such a row fails on every pass: read [Secrets](/docs/operations/secrets/) before you remove its version.

The command never reads a sealed value. The route reseals each row inside the deployment, and answers counts only.

:::caution
Warning: remove a version from `secrets` only when its four counts are 0 in `authtempo secret status`. A backup code and an email code cannot move: each matches under its version until it is used, replaced, or expired.
:::

## The JSON

| Key | What it holds |
| --- | --- |
| `calls` | The calls of the run. |
| `resealed` | The rows that the run moved to the current version, summed over the calls. |
| `failed` | The rows that did not open or did not write, summed over the calls. |
| `skipped` | The live setups with codes that the calls left, summed over the calls. A later pass moves them. |
| `more` | The `more` of the last call: true while a row under a configured old version remains. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

A stop in the middle of the loop keeps the sums of the calls before it, with `exit: 2` and the reason in `stopped`. The document of a usage error holds `calls: 0`, each other count 0, `more: false`, and the reason. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

## The route

| Field | Value |
| --- | --- |
| Route | [`POST /operator/secrets/rewrap`](/docs/reference/routes/#post-operator-secrets-rewrap) |
| Header | `Authorization: Operator <secret>` |
| Body | `{ limit, after }`: the rows of the call, and the cursor of the answer before, when there is one. |
| Answer | `{ resealed, failed, skipped, more, next }`, the answer of `api.secrets.rewrap({ limit, after })`. |
| Limit | The key `operator-secrets:ip:<ip>`, a window of 1 hour, and 120 calls, right or wrong secret, shared with `secret status` and `info`. A run of 100 calls fits in one hour. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited), [`invalid_body`](/docs/reference/errors/#invalid_body) |

A deployment with no `operator` in its config answers 404, and the command stops with exit 2.

## Next

- [Secrets](/docs/operations/secrets/)
- [authtempo secret status](/docs/reference/cli/secret-status/)
- [Routes](/docs/reference/routes/)
