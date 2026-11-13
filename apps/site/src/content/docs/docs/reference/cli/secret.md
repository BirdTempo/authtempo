---
title: authtempo secret
description: Make a new app secret or operator secret from 32 random bytes, printed once or written to a new private file.
type: reference
sources:
  - packages/cli/src/commands/secret.ts
  - packages/cli/src/help/secret.ts
sidebar:
  order: 8
---

**For:** an operator who adds a version of the app secret, or who makes the operator secret of a deployment.

**What it does:** this page lists the flags of `authtempo secret`, its JSON document, and the four rules of the generator.

## Before you start

- For an app secret: know the two-phase change of a version. [Secrets](/docs/operations/secrets/) gives the steps.
- For an operator secret: the operator routes read the entries of `operator.secrets` from the config. [Configuration](/docs/reference/config/) lists the key.

## The command

The `@authtempo` packages are on npm. Add the CLI to your app with `pnpm add -D @authtempo/cli`, and run each command as `pnpm exec authtempo …`.

```sh
authtempo secret --version 2
authtempo secret --version 2 --out secret-v2.txt
authtempo secret --operator
```

| Flag | What it does |
| --- | --- |
| `--version <n>` | The version of the app secret, from 1 to 999999. The value does not change with it. The command then prints the next step of the change. |
| `--out <path>` | Writes the value to a new file with mode 0600, and prints no value. The command refuses a path that exists. It needs `--version` or `--operator`. |
| `--operator` | Makes an operator secret, and prints its SHA-256 as `secretHash: <hex>` for the `secretHash` of an entry of `operator.secrets`. Do not give it with `--version`. |
| `--json` | Prints the document of [The JSON](#the-json). `exit`: the exit code of the run. `stopped`: the reason of a stop or a usage error, or null. |
| `-h`, `--help` | Prints the complete help. The command ignores every other argument. |

| Exit code | What it means |
| --- | --- |
| 0 | The command printed or wrote the value. |
| 2 | A usage error, a path that exists, or a stop: the random source gave three weak values. |

Without `--out`, the value is the one stdout line, and the hints go to stderr. With `--out`, no line holds the value: the file holds it, and stderr names the file.

## The JSON

| Key | What it holds |
| --- | --- |
| `kind` | `app` or `operator`. |
| `value` | The secret, or null with `--out`: the file holds it. |
| `version` | The number of `--version`, or null. |
| `bytes` | The bytes of the random draw: 32. |
| `estimateBits` | The estimate of core for the value, rounded down. A value under 120 is drawn again. |
| `out` | The absolute path of the file of `--out`, or null. |
| `secretHash` | The SHA-256 of the value as 64 hex characters, with `--operator` only; else null. |
| `exit` | The exit code of the run. |
| `stopped` | The reason of a stop or a usage error, or null. |

The document of a stop or a usage error holds `kind: "app"`, each other key empty, `exit: 2`, and the reason in `stopped`. [The output](/docs/reference/cli/#the-output) gives the rule for every command.

## Secrets

- The value comes from the Web Crypto source of the runtime: 32 bytes as 43 characters of base64url. A draw that core would warn on is drawn again, and three weak draws stop the command.
- The value goes out once: as the one stdout line, or into one new file with mode 0600. Never both, and never on stderr. After that write, the scrub of the CLI hides the value from every later line.
- The command uses no clipboard and writes no log. It keeps no copy: a lost value is a new value.
- The command replaces no file and follows no link. A path that exists stops it with no byte changed, because a replaced app secret locks out each second-factor user.

## Next

- [Secrets](/docs/operations/secrets/)
- [authtempo secret status](/docs/reference/cli/secret-status/)
- [authtempo secret rewrap](/docs/reference/cli/secret-rewrap/)
