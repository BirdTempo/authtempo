---
title: authtempo secret status
description: Count the rows of each app secret version on a deployment through the operator route, with no value read.
type: reference
sources:
  - packages/cli/src/commands/secret.ts
  - packages/cli/src/help/secret.ts
  - docs/superpowers/plans/2026-10-14-11c2-cli-additions.md "Task 4"
sidebar:
  order: 9
---

**For:** an operator who changes the app secret and wants to know when an old version can leave the config.

**What it does:** this page lists the flags of `authtempo secret status`, its JSON document, and the operator route that it calls.

## Before you start

- The operator routes on, with `operator: { secretHash }` in the config. [Configuration](/docs/reference/config/) lists the key. Core serves the route since plan 11c2.
- The two-phase change of a version. [Secrets](/docs/operations/secrets/) gives the steps.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo secret status https://api.example.com
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--token-env <NAME>` | The variable of the operator secret. The default is `AUTHTEMPO_OPERATOR_SECRET`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--token-file <path>` | The file of the operator secret. A dash reads stdin. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of each request, from 1 to 120. The default is 10. |
| `--json` | Prints the document of [The JSON](#the-json). `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | Each version that has rows is in the config. |
| 1 | A version that the config does not hold has rows. A person must look before the version goes. |
| 2 | A usage error, or a stop: no answer, the route is off, or the deployment refused the secret. |

The command prints one line per version on stdout, the current version first:

```text
version 2: current, configured, totpSecrets 0, backupCodes 0, signingKeys 0, emailCodes 0, ssoClientSecrets 0
version 1: old, configured, totpSecrets 1, backupCodes 10, signingKeys 1, emailCodes 0, ssoClientSecrets 0
```

- `current` or `old`: whether the version seals each new value.
- `configured` or `not configured`: whether the config holds the version.
- The five counts: the TOTP secrets, the unused backup codes, the signing keys, the live email codes, and the SSO client secrets under the version.

A version that the config does not hold but has rows gives exit 1 and a warning on stderr. Its rows cannot open until the version is back. Add it back before you remove it: [Secrets](/docs/operations/secrets/) gives the rule.

The command reads counts only. No line holds a secret, a hash, or a sealed value.

## The JSON

| Key | What it holds |
| --- | --- |
| `versions` | One entry per version, the current version first. Each entry holds `version`, `configured`, `current`, `totpSecrets`, `backupCodes`, `signingKeys`, `emailCodes`, and `ssoClientSecrets`: the key names of `api.secrets.status()`. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop or a usage error holds `versions: []`, `exit: 2`, and the reason in `stopped`. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

## The route

| Field | Value |
| --- | --- |
| Route | [`GET /operator/secrets/status`](/docs/reference/routes/#get-operator-secrets-status) |
| Header | `Authorization: Operator <secret>` |
| Answer | `{ versions }`, the answer of `api.secrets.status()`. |
| Limit | The key `operator-secrets:ip:<ip>`, a window of 1 hour, and 120 calls, right or wrong secret, shared with `secret rewrap` and `info`. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

A deployment with no `operator` in its config answers 404, and the command stops with exit 2.

## Next

- [Secrets](/docs/operations/secrets/)
- [authtempo secret rewrap](/docs/reference/cli/secret-rewrap/)
- [Routes](/docs/reference/routes/)
