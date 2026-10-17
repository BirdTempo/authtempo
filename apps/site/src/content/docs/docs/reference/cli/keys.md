---
title: authtempo keys rotate
description: Make a new signing key on a deployment through the operator route, and know the rotation timer of core.
type: reference
sources:
  - packages/cli/README.md "keys rotate"
  - packages/core/README.md "JWT minting"
  - docs/superpowers/plans/2026-10-14-11c-cli.md "Task 3"
sidebar:
  order: 6
---

**For:** an operator who rotates the signing key of the JWTs on a schedule, or after a leak.

**What it does:** this page lists the flags of `authtempo keys rotate`, the operator route that it calls, and the timer of core.

## Before you start

- `jwtMint` on. It is on by default. [Mint a JWT for your other services](/docs/guides/jwt/) tells how.
- The operator route on, with `operator: { secretHash }` in the config. [Configuration](/docs/reference/config/) lists the key.

## The command

The packages are not on a registry yet. In this repo, run each command below as `node /path/to/authtempo/packages/cli/dist/bin/authtempo.js …` in the folder of your app. [Run it from this repo](/docs/reference/cli/#run-it-from-this-repo) tells how. The pnpm filter form runs in `examples/worker` and exits 1 on any failure, so use it for `--help` only.

```sh
authtempo keys rotate https://api.example.com --yes
```

| Flag | What it does |
| --- | --- |
| `<base url>` | The origin of the API, with no path. |
| `--token-env <NAME>` | The variable of the operator secret. The default is `AUTHTEMPO_OPERATOR_SECRET`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--token-file <path>` | The file of the operator secret. A dash reads stdin, and then the command needs `--yes`. [Secrets](/docs/reference/cli/#secrets) gives the rule. |
| `--base-path <path>` | The `basePath` of the deployment. The default is `/auth`. |
| `--timeout <seconds>` | The time limit of each request, from 1 to 120. The default is 10. |
| `--yes` | Rotates with no question. A run with no terminal needs it. |
| `--no-input` | Asks no question. Without `--yes`, the command stops. |
| `--json` | Prints `{ kid, exit, stopped }`. `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The deployment made a new key. The command prints its kid. |
| 2 | A usage error, or a stop: no answer, the route is off, or the deployment refused the secret. |

The command prints `kid: <kid>` only. It reads the key set before and after the call, and warns when a cache still serves the old set.

## The operator secret

```sh
openssl rand -base64 32
printf '%s' "$AUTHTEMPO_OPERATOR_SECRET" | shasum -a 256
```

- The first command makes a secret of 32 random bytes. The second prints its SHA-256 for `operator.secretHash`.
- Core stores the hash, never the secret. It hashes the presented secret and compares the two digests in constant time.
- The secret is not an API token. No user owns it, and no session reaches the route.

## The route

| Field | Value |
| --- | --- |
| Route | [`POST /operator/keys/rotate`](/docs/reference/routes/#post-operator-keys-rotate) |
| Header | `Authorization: Operator <secret>` |
| Answer | `{ kid }`. The old key verifies for 24 hours and signs nothing. |
| Limit | The key `operator:ip:<ip>`, a window of 1 hour, and 5 calls, right or wrong secret. [Limits](/docs/reference/limits/) lists every limit. |
| Errors | [`unauthorized`](/docs/reference/errors/#unauthorized), [`rate_limited`](/docs/reference/errors/#rate_limited) |

## The timer

- `jwtMint.rotateEvery` is a number of days from 1 to 365. It is off by default.
- The first signature with a key of that age makes a new key. A read of the key set never rotates.
- Two signatures at once make one new key. The old key verifies for 24 hours.

:::caution
Warning: a leaked key still verifies for 24 hours after a rotation. Tell each server that checks the tokens to refuse its `kid`.
:::

## Next

- [Key rotation](/docs/operations/key-rotation/)
- [Mint a JWT for your other services](/docs/guides/jwt/)
- [Routes](/docs/reference/routes/)
