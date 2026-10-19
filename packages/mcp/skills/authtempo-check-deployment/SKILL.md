---
name: authtempo-check-deployment
description: Check a deployed authtempo API from this machine with the check tool of the authtempo MCP server, and fix each failure from the page of its code. Use it after a deploy, or when sign-in fails on a deployment. In the steps, {base_url} is the origin of the API.
metadata:
  source: /docs/reference/cli/check/
---

# Check an authtempo deployment

**For:** a coding agent that checks the public documents of a deployed authtempo API for a person.

**What it does:** the `check` tool fetches the public documents of the API, sends no credential, and writes nothing. Each failure has a code with its own section.

## Before you start

- The authtempo MCP server runs in this project.
- An API with authtempo, deployed at an origin with `https`.

## Steps

1. Call `check` with `base_url` set to {base_url}. Pass `base_path` when the API is not under `/auth`.
2. Read the `summary` and each entry of `checks`. A check with `skip` is no pass.
3. For each failure, call `docs.read` with the path `/docs/reference/cli/check/` and the code as the section.
4. Fix the cause with the person, and deploy again.
5. Call `check` again, until each check passes.
6. The tool skips the two schema checks. Run them in the shell, with the origin as the first argument.
7. On D1, run `authtempo check --target d1 --database <name>` with the database name of the wrangler config.
8. On Postgres, run `authtempo check --target postgres`. It reads the connection string from `DATABASE_URL`.

## If it fails

- The answer has `stopped`: the host did not answer, or an input is wrong. [The exit codes](/docs/reference/cli/#the-exit-codes) give each code.
- The `https` check: [`base_not_https`](/docs/reference/cli/check/#base_not_https).
- The `mount` check: [`mount_missing`](/docs/reference/cli/check/#mount_missing), [`mount_wrong_answer`](/docs/reference/cli/check/#mount_wrong_answer), [`no_mount`](/docs/reference/cli/check/#no_mount).
- The `origin_rule` check: [`origin_not_enforced`](/docs/reference/cli/check/#origin_not_enforced).
- The `cookie` check: [`cookie_missing`](/docs/reference/cli/check/#cookie_missing), [`cookie_not_httponly`](/docs/reference/cli/check/#cookie_not_httponly), [`cookie_not_secure`](/docs/reference/cli/check/#cookie_not_secure), [`cookie_path_not_root`](/docs/reference/cli/check/#cookie_path_not_root), [`cookie_no_samesite`](/docs/reference/cli/check/#cookie_no_samesite), [`cookie_samesite_none`](/docs/reference/cli/check/#cookie_samesite_none).
- The `jwks` check: [`jwt_mint_off`](/docs/reference/cli/check/#jwt_mint_off), [`jwks_bad_answer`](/docs/reference/cli/check/#jwks_bad_answer), [`jwks_empty`](/docs/reference/cli/check/#jwks_empty), [`jwks_private_part`](/docs/reference/cli/check/#jwks_private_part), [`jwks_bad_key`](/docs/reference/cli/check/#jwks_bad_key), [`jwks_no_cache_control`](/docs/reference/cli/check/#jwks_no_cache_control), [`jwks_cache_not_public`](/docs/reference/cli/check/#jwks_cache_not_public).
- The `well_known` check: [`oauth_off`](/docs/reference/cli/check/#oauth_off), [`well_known_bad_answer`](/docs/reference/cli/check/#well_known_bad_answer), [`well_known_mismatch`](/docs/reference/cli/check/#well_known_mismatch), [`well_known_issuer`](/docs/reference/cli/check/#well_known_issuer), [`well_known_jwks_uri`](/docs/reference/cli/check/#well_known_jwks_uri), [`well_known_not_at_root`](/docs/reference/cli/check/#well_known_not_at_root).
- The `schema_version` check: [`no_database`](/docs/reference/cli/check/#no_database), [`schema_missing`](/docs/reference/cli/check/#schema_missing), [`schema_behind`](/docs/reference/cli/check/#schema_behind), [`schema_ahead`](/docs/reference/cli/check/#schema_ahead).

## Next

- [authtempo check](/docs/reference/cli/check/)
- [Upgrades](/docs/operations/upgrades/)
