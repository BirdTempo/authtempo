---
"@authtempo/cli": minor
---

Breaking: the binary `authtempo-import` is removed. Run `authtempo import` instead.

In place of `--postgres <url>`, give `--target postgres` with `--url-env <NAME>` or `--url-file <path>`. In place of `--d1-bundle <file>`, give `--target d1-bundle --out <file>`.
