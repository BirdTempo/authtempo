---
title: The MCP server
description: The two surfaces, every tool with its inputs and hints, the resources, the prompts, and the owned limits of the authtempo MCP server.
type: reference
sources:
  - packages/mcp/src/tools.ts
  - packages/mcp/src/resources.ts
  - packages/mcp/src/prompts.ts
  - packages/mcp/src/limits.ts
  - packages/mcp/src/plans.ts
  - packages/mcp/src/worker.ts
  - packages/mcp/wrangler.jsonc
  - packages/mcp/test/drift.test.ts
  - docs/superpowers/specs/2026-10-09-tempo-auth-design.md 21
  - docs/superpowers/plans/2026-10-14-11e-mcp.md "Task 17"
---

**For:** a developer or an agent that calls the authtempo MCP server and needs each tool, input, and rule.

**What it does:** this page lists the surfaces, the tools, the resources, the prompts, and the limits of the server. The check `check-mcp` holds this page to what the built server answers on the wire.

## Before you start

- The server package, built in this repo. [Set up an agent](/docs/guides/agents/) tells how.
- [authtempo mcp](/docs/reference/cli/mcp/) writes the entry of the server into the config of an editor.

## The two surfaces

| Surface | How it runs | Tools |
| --- | --- | --- |
| Local | `authtempo-mcp` on stdio, in the project folder. The editor starts it from the entry that `authtempo mcp` writes. | Every tool |
| Remote | `https://mcp.authtempo.com/mcp`, a stateless Worker with no authentication. It is not live before publication. | `docs.search`, `docs.read`, `version` |

Both surfaces serve the resources and the prompts. Each surface speaks the revision 2026-07-28 and the 2025 handshake.

The local server takes three flags:

| Flag | What it does |
| --- | --- |
| `--root <dir>` | The server root. Every path of a tool input must resolve inside it. The default is the current folder. |
| `--url-env <NAME>` | The variable that holds the connection string. The default is `DATABASE_URL`. |
| `--index <file>` | The docs index. The default is `dist/agent/index.json` of the package. |

The remote server answers a POST to `/mcp` only. Another path answers 404, and another method answers 405. Another `Host` than `mcp.authtempo.com` answers 403. A request with an `Origin` header answers 403, because the list of allowed origins is empty. A client on a server sends no `Origin`, and passes.

## Tools

Each tool has a strict input: a key that its table does not list is an input error. A tool fault is a tool result with `isError: true`, never a protocol error. Each result holds the structured content and the same JSON as text.

<h3 id="tool-docs-search"><code>docs.search</code></h3>

Reads no file and writes nothing. Searches the sections of the authtempo docs and answers the best sections, each with its page path, its anchor, and a short snippet.

| Fact | Value |
| --- | --- |
| Title | Search the authtempo docs |
| Surfaces | local, remote |
| `readOnlyHint` | `true` |
| `destructiveHint` | `false` |
| `idempotentHint` | `true` |
| `openWorldHint` | `false` |
| Output keys | `version`, `results` |

| Input | Type | Rules | What it is |
| --- | --- | --- | --- |
| `query` | string | required; 2 to 200 characters | The words to search for. |
| `limit` | integer | default `5`; 1 to 10 | The most hits to answer. |
| `type` | string | optional; one of `tutorial`, `how-to`, `reference`, `explanation` | Only the pages of this type. |
| `version` | string | default `"latest"`; 1 to 40 characters | The docs version. One of header.versions of the index; "latest" by default. |

<h3 id="tool-docs-read"><code>docs.read</code></h3>

Reads no file and writes nothing. Answers the agent markdown of one docs page, or of one section of it. With no path, it answers the index of every page.

| Fact | Value |
| --- | --- |
| Title | Read an authtempo docs page |
| Surfaces | local, remote |
| `readOnlyHint` | `true` |
| `destructiveHint` | `false` |
| `idempotentHint` | `true` |
| `openWorldHint` | `false` |
| Output keys | `version`, `path`, `title`, `description`, `type`, `sources`, `markdown`, `links` |

| Input | Type | Rules | What it is |
| --- | --- | --- | --- |
| `path` | string | optional; 1 to 200 characters | A page path such as /docs/guides/magic-link/. With no path, the index. |
| `section` | string | optional; 1 to 200 characters | The anchor of one section of the page, such as steps. |
| `version` | string | default `"latest"`; 1 to 40 characters | The docs version. One of header.versions of the index; "latest" by default. |

<h3 id="tool-version"><code>version</code></h3>

Reads no file and writes nothing. Answers the versions of @authtempo/core, the CLI, and this server, the schema version, the protocol revision, and the facts of the docs index.

| Fact | Value |
| --- | --- |
| Title | The versions of authtempo and of the docs index |
| Surfaces | local, remote |
| `readOnlyHint` | `true` |
| `destructiveHint` | `false` |
| `idempotentHint` | `true` |
| `openWorldHint` | `false` |
| Output keys | `core`, `cli`, `mcp`, `schemaVersion`, `protocol`, `docsIndex` |

The tool takes no input.

<h3 id="tool-scaffold"><code>scaffold</code></h3>

Writes the files of a new app into dir, inside the server root, and overwrites no file. It runs authtempo init with the stack, and answers each file it wrote and the next steps. It runs no install.

| Fact | Value |
| --- | --- |
| Title | Write a new authtempo app |
| Surfaces | local |
| `readOnlyHint` | `false` |
| `destructiveHint` | `false` |
| `idempotentHint` | `false` |
| `openWorldHint` | `false` |
| Output keys | `stack`, `dir`, `files`, `next`, `exit`, `stopped` |

| Input | Type | Rules | What it is |
| --- | --- | --- | --- |
| `dir` | string | required; 1 to 200 characters; matches `^[^-]` | A relative path of a new folder inside the server root, such as apps/web. |
| `stack` | string | required; one of `workers-d1`, `workers-postgres`, `node`, `bun`, `mcp-server` | The stack of the app. |

<h3 id="tool-migrate-plan"><code>migrate.plan</code></h3>

Plans an import and writes nothing. It reads the export files inside the server root and runs authtempo import with --dry-run. With against "empty" it plans against an empty store. With against "database" it plans against the database that the server's environment names, and answers a plan_id for migrate.run. It answers the report and the shell command of the real run.

| Fact | Value |
| --- | --- |
| Title | Plan an import of users from another provider |
| Surfaces | local |
| `readOnlyHint` | `true` |
| `destructiveHint` | `false` |
| `idempotentHint` | `true` |
| `openWorldHint` | `false` |
| Output keys | `report`, `stopped`, `bundle`, `exit`, `against`, `plan_id`, `next` |

| Input | Type | Rules | What it is |
| --- | --- | --- | --- |
| `provider` | string | required; one of `supabase`, `clerk`, `auth0`, `firebase`, `authjs`, `cognito`, `workos` | The provider of the export. |
| `users` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the users export. |
| `identities` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the identities export (Supabase, WorkOS). |
| `csv` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the CSV export (Clerk). |
| `hashes` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the password hash export (Auth0). |
| `organizations` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the organizations export (Clerk, Auth0, WorkOS). |
| `memberships` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the organization memberships export (WorkOS). |
| `authjs_tables` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the Auth.js tables export. |
| `formats` | string | optional; 1 to 200 characters | The formats list of the app's createLegacyPasswordHash, comma-separated, or none. Each provider but Cognito and WorkOS needs it. |
| `role_map` | string | optional; 1 to 1000 characters | Source role to owner, admin, or member, such as org:admin=admin,basic=member. |
| `reserved_slugs` | string | optional; 1 to 1000 characters | The reserved organization slugs, comma-separated. |
| `platform_slug` | string | optional; 1 to 100 characters | The slug of the platform organization. |
| `on_email_taken` | string | optional; one of `skip`, `fail` | What a taken address does: skip the record (the default), or stop the run. |
| `password_column` | string | optional; 1 to 100 characters | The column of the Auth.js users table that holds the password hash. |
| `same_passkey_rp_id` | boolean | optional | True when the app keeps the passkey rp id of the Auth.js app. |
| `legacy_verify` | boolean | optional | True when the app sets password.legacyVerify. A Cognito import needs it. |
| `firebase_signer_key_env` | string | optional; 1 to 100 characters; matches `^[A-Za-z_][A-Za-z0-9_]*$` | The name of the variable that holds the Firebase signer key, never the key. |
| `firebase_salt_separator` | string | optional; 1 to 200 characters | The salt separator of the Firebase project. |
| `firebase_rounds` | integer | optional; 0 to 1000 | The rounds of the Firebase project. |
| `firebase_mem_cost` | integer | optional; 0 to 1000 | The mem cost of the Firebase project. |
| `tables` | string | default `"core"`; one of `core`, `compat` | The table set: core, or compat for a Better Auth schema. |
| `against` | string | default `"empty"`; one of `empty`, `database` | Plan against an empty store ("empty", no database) or against the database ("database"). Only a plan against the database gives a plan_id. |

<h3 id="tool-migrate-run"><code>migrate.run</code></h3>

Writes the users of a held plan into the database that the server's environment names. It takes the plan_id of a migrate.plan against the database, with the same input and the same files, once, within 10 minutes. It runs authtempo import with --target postgres.

| Fact | Value |
| --- | --- |
| Title | Run a held import plan |
| Surfaces | local |
| `readOnlyHint` | `false` |
| `destructiveHint` | `true` |
| `idempotentHint` | `false` |
| `openWorldHint` | `false` |
| Output keys | `report`, `stopped`, `bundle`, `exit` |

| Input | Type | Rules | What it is |
| --- | --- | --- | --- |
| `provider` | string | required; one of `supabase`, `clerk`, `auth0`, `firebase`, `authjs`, `cognito`, `workos` | The provider of the export. |
| `users` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the users export. |
| `identities` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the identities export (Supabase, WorkOS). |
| `csv` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the CSV export (Clerk). |
| `hashes` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the password hash export (Auth0). |
| `organizations` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the organizations export (Clerk, Auth0, WorkOS). |
| `memberships` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the organization memberships export (WorkOS). |
| `authjs_tables` | string | optional; 1 to 200 characters; matches `^[^-]` | A relative path inside the server root: the Auth.js tables export. |
| `formats` | string | optional; 1 to 200 characters | The formats list of the app's createLegacyPasswordHash, comma-separated, or none. Each provider but Cognito and WorkOS needs it. |
| `role_map` | string | optional; 1 to 1000 characters | Source role to owner, admin, or member, such as org:admin=admin,basic=member. |
| `reserved_slugs` | string | optional; 1 to 1000 characters | The reserved organization slugs, comma-separated. |
| `platform_slug` | string | optional; 1 to 100 characters | The slug of the platform organization. |
| `on_email_taken` | string | optional; one of `skip`, `fail` | What a taken address does: skip the record (the default), or stop the run. |
| `password_column` | string | optional; 1 to 100 characters | The column of the Auth.js users table that holds the password hash. |
| `same_passkey_rp_id` | boolean | optional | True when the app keeps the passkey rp id of the Auth.js app. |
| `legacy_verify` | boolean | optional | True when the app sets password.legacyVerify. A Cognito import needs it. |
| `firebase_signer_key_env` | string | optional; 1 to 100 characters; matches `^[A-Za-z_][A-Za-z0-9_]*$` | The name of the variable that holds the Firebase signer key, never the key. |
| `firebase_salt_separator` | string | optional; 1 to 200 characters | The salt separator of the Firebase project. |
| `firebase_rounds` | integer | optional; 0 to 1000 | The rounds of the Firebase project. |
| `firebase_mem_cost` | integer | optional; 0 to 1000 | The mem cost of the Firebase project. |
| `tables` | string | default `"core"`; one of `core`, `compat` | The table set: core, or compat for a Better Auth schema. |
| `plan_id` | string | required; 1 to 100 characters | The plan_id of a migrate.plan with against "database". |
| `confirm` | boolean | required; only `true` | true: the person read the plan and wants the run. |

<h3 id="tool-schema-migrate"><code>schema.migrate</code></h3>

Writes the authtempo migrations into the Postgres database that the server's environment names, after a dry run. With dry_run: true it writes nothing, and answers the pending migrations and a plan_id. With that plan_id and confirm: true it runs the dry run again, refuses when the database changed, and applies the plan. D1 is not a tool: run `authtempo migrate --target d1` in the shell.

| Fact | Value |
| --- | --- |
| Title | Migrate the Postgres schema of authtempo |
| Surfaces | local |
| `readOnlyHint` | `false` |
| `destructiveHint` | `true` |
| `idempotentHint` | `false` |
| `openWorldHint` | `false` |
| Output keys | `target`, `tables`, `dryRun`, `before`, `after`, `pending`, `applied`, `copied`, `exit`, `stopped`, `plan_id`, `next` |

| Input | Type | Rules | What it is |
| --- | --- | --- | --- |
| `tables` | string | default `"core"`; one of `core`, `compat` | The table set: core, or compat for a Better Auth schema. |
| `dry_run` | boolean | optional | true: list the pending migrations, write nothing, and answer a plan_id. |
| `plan_id` | string | optional; 1 to 100 characters | The plan_id of a dry run of this tool. Give it with confirm: true. |
| `confirm` | boolean | optional | true with plan_id: the person read the plan and wants the run. |

<h3 id="tool-check"><code>check</code></h3>

Fetches the public documents of a deployment from this machine, sends no credential, and writes nothing. It runs authtempo check on base_url, and fetches no other origin. It answers each check as its id, status, code, and docs link, and each warning as its code. It answers no text of the deployment. The tool skips the two schema checks: run authtempo check with --target in the shell for them.

| Fact | Value |
| --- | --- |
| Title | Check a deployed authtempo API |
| Surfaces | local |
| `readOnlyHint` | `true` |
| `destructiveHint` | `false` |
| `idempotentHint` | `true` |
| `openWorldHint` | `true` |
| Output keys | `base`, `checks`, `warnings`, `summary`, `exit`, `stopped` |

| Input | Type | Rules | What it is |
| --- | --- | --- | --- |
| `base_url` | string | required; at most 2048 characters | The origin of the deployment, such as https://api.example.com. |
| `base_path` | string | default `"/auth"`; 1 to 200 characters; matches `^\/` | The basePath of the deployment's config, /auth by default. |
| `strict` | boolean | default `false` | true: each skip counts as a failure, except compat_database. |

The `base_url` of `check` must be an origin: `http` or `https`, with no path, query, fragment, user name, or password. Each other value is an input error, and the CLI does not run.

The answer of `check` holds codes only. It holds no detail, no header value, and no value of a document that the deployment wrote. So a deployment cannot put text in the context of the agent. A stop of the run answers the reason only when the reason names the tool's own input; each other stop answers a fixed text.

The first read of the key set can make core write its first signing key on the deployment. The tool writes nothing on this machine.

## Resources

Each docs page is one resource. Its URI is `authtempo://docs/<path>`: the page path with no final slash. The home page is `authtempo://docs/index`. The text of a resource is the agent markdown of the page.

| Template | Name | MIME type |
| --- | --- | --- |
| `authtempo://docs/{+path}` | `docs-page` | `text/markdown` |

`resources/list` answers 100 resources a page, in the sidebar order. Its `nextCursor` holds the key of the docs index and the offset of the next page. The key is the commit of the index and a hash of its page paths. A cursor of another index build answers -32602.

A read of a page that does not exist answers the protocol error -32602, with the URI in `data.uri`. The 2026-07-28 revision requires -32602. Older SDK builds sent -32002, so a client accepts either code when `data` holds `uri`.

## Prompts

Each prompt is one skill of the skill pack, with the same text. The local and the remote surface list the same prompts. An argument that a prompt does not name answers -32602.

| Prompt | Title | Arguments |
| --- | --- | --- |
| `check-deployment` | Check an authtempo deployment | `base_url` (optional) |
| `integrate-binding` | Add an authtempo framework package | `binding` (required) |
| `integrate-bun` | Add authtempo to a new Bun server | `dir` (optional) |
| `integrate-node` | Add authtempo to a new Node server | `dir` (optional) |
| `integrate-workers-d1` | Add authtempo to a new Worker on D1 | `dir` (optional) |
| `integrate-workers-postgres` | Add authtempo to a new Worker on Postgres | `dir` (optional) |
| `migrate-auth0` | Move the users of Auth0 to authtempo | none |
| `migrate-authjs` | Move the users of Auth.js to authtempo | none |
| `migrate-better-auth` | Move an app from Better Auth to authtempo | none |
| `migrate-clerk` | Move the users of Clerk to authtempo | none |
| `migrate-cognito` | Move the users of Amazon Cognito to authtempo | none |
| `migrate-firebase` | Move the users of Firebase Auth to authtempo | none |
| `migrate-supabase` | Move the users of Supabase Auth to authtempo | none |
| `migrate-workos` | Move the users of WorkOS to authtempo | none |
| `protect-mcp-server` | Protect an MCP server with authtempo | `dir` (optional) |

The `binding` argument takes one name of the bindings of the docs index, such as `next` or `hono`. `prompts/list` does not show the names. Each binding has its reference page, such as [The Next.js package](/docs/reference/next/).

## Owned limits of the remote server

The Worker checks each limit before the SDK reads the body. The values are in `packages/mcp/src/limits.ts`, in code that this project owns.

| Limit | Value | Why |
| --- | --- | --- |
| `bodyBytes` | `65536` | A docs call is under 1 KiB. A larger body answers 413 before the parse. |
| `queryChars` | `200` | The longest `docs.search` query. The input schema of the tool holds the same value. |
| `limit` | `10` | The most hits of one `docs.search` call. |
| `resourcePage` | `100` | The resources of one `resources/list` page. |
| `callsPerMinute` | `120` | The calls of one client IP in one isolate. The next call answers 429 with `retry-after: 60`. |
| `windowMs` | `60000` | The window of `callsPerMinute`, in milliseconds. |
| `bindingPerMinute` | `60` | The calls of one client IP a minute through a Workers rate limiting binding. The binding in `wrangler.jsonc` holds the same value. |

The `bindingPerMinute` limit is eventually consistent and local to a location. So it helps and never holds the limit alone.

## What stays in the shell

The drift test of the package holds these lists, because `check-mcp` reads only the wire.

- No tool runs `authtempo keys`, `authtempo mcp`, `authtempo secret`, or `authtempo info`. `keys` needs the operator secret and changes a live deployment. `mcp` installs this server. `secret` makes a secret, and a secret must not enter the context of an agent. Its subcommands need the operator secret, and `secret rewrap` changes a live deployment. `info` is a support report for a person.
- D1 migrations stay a shell command: run `authtempo migrate --target d1`. The `schema.migrate` tool serves Postgres only.
- The `check` tool skips the two schema checks, because they need a database. Run `authtempo check` with `--target` in the shell for them.
- No tool passes `--repair` to `authtempo import`. A repair writes into users that exist, so check each such user in the app, then run it in the shell.
- The `check` tool keeps the timeout of the CLI, 10 s a request. So one call to a slow host can take about 70 s.

## The rules

- **No secret.** No tool input is a secret, a connection string, a token, or a key. The server reads the connection string from the variable that `--url-env` names. Each line that a wrapped command prints passes the scrub of the CLI.
- **The root.** Every path of a tool input resolves inside the server root, with each symbolic link resolved. A path outside it is a tool result with `isError: true`, and nothing is written. The tools run no child process and read no stdin.
- **The plan handle.** `migrate.run` and `schema.migrate` run only a plan of the same server run. A plan is held 10 minutes and is used once. It binds the input, the database, and the SHA-256 of each file. The server holds at most 16 plans.
- **No telemetry.** The local server makes no network call at its start and none for a docs tool. Only `check` fetches, and only from the origin it gets. The remote Worker stores no query, keeps no IP after the isolate ends, and logs no request.

## Next

- [Set up an agent](/docs/guides/agents/)
- [authtempo mcp](/docs/reference/cli/mcp/)
- [Protect your MCP server](/docs/guides/mcp-server/)
