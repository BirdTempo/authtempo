# @authtempo/cli

The `authtempo` command line: set up, migrate, import into, check, and
maintain an authtempo deployment, and support its users. Spec section 19 holds its rules.

```bash
authtempo --help
authtempo help <command>
```

## Install

Install the CLI with `pnpm add -D @authtempo/cli`, or run it with
`pnpm dlx @authtempo/cli`.

## The rules

- Exit codes: 0 done; 1 a person must look (a failed check, an import
  record or a secret row that needs a person, an info part with no
  answer); 2 a usage error, a malformed input, or a stop. A stop prints one
  `stopped:` line on stderr.
- stdout holds the result. Usage errors, warnings, the `stopped:` line,
  and each progress line that names what the command reads or connects to
  go to stderr. A result line may name a file or the base URL, such as
  `wrote <path>` of `init`. `--json` prints one JSON document on stdout;
  `src/json.ts` exports each shape. Each document holds `exit`, the exit
  code of the run, and `stopped`, the reason of a stop or null. On a usage
  error or a stop, `--json` prints one document with `exit: 2`, the reason
  in `stopped`, and the empty value of each other key. `--version --json`
  has neither key.
- No flag takes a secret as its value. A connection string comes from
  `--url-env <NAME>` (default `DATABASE_URL`) or `--url-file <path>`; the
  operator secret from `--token-env <NAME>` (default
  `AUTHTEMPO_OPERATOR_SECRET`) or `--token-file <path>`. A file of `-` is
  stdin. No output line holds a secret that the command read.
- `--help`, `-h`, and `help <command>` print the complete help, with the
  link to the command's page under
  `https://authtempo.com/docs/reference/cli/`. A flag one edit from a known
  flag gets "Did you mean", and the command does not run.
- The CLI writes no color and no terminal control.

## init

```bash
authtempo init my-app --stack workers-d1
```

The stacks are `workers-d1`, `workers-postgres`, `node`, and `bun`. The
files are those of the example apps of the docs (`examples/worker-d1`,
`examples/worker-postgres`, `examples/node`), with five declared rewrites
only: the name `my-app`, the exact version of each `@authtempo` package,
the scaffold's own copy of `tsconfig.base.json`, the D1 test script
without the repo's bundle proof, and the Bun start script `bun src/main.ts`.
Each stack adds a `README.md`, a `.gitignore`, and `.dev.vars.example` or
`.env.example`, which lists each secret with no value. `init` runs no
install and writes no secret. A folder that holds any of its files stops
the run, and nothing is written. A scaffold names each
`@authtempo` package at the version of the CLI.

## migrate

```bash
authtempo migrate --target postgres --url-env DATABASE_URL
```

Every run reads the schema version first: the row `schema_version` of
`ta_meta`. A database newer than this CLI's core stops the run with exit 2
before any write. `--dry-run` lists the migrations that the database lacks.
A run applies them through `applyPostgresMigrations` (its advisory lock
keeps two runs at once safe), reads the version again, and exits 0 only at
this CLI's schema version. `--tables compat` runs the migrations of
`@authtempo/compat-better-auth` on the Better Auth 1.7 tables; that package
refuses a schema with core's own `ta_meta` and `ta_limit`.

```bash
authtempo migrate --target d1 --database my-app --remote
```

On D1 the command runs the project's own wrangler from
`node_modules/.bin`; the CLI ships none. It reads `wrangler.jsonc` (or
`wrangler.json`, or `--config`) in the current folder and takes the one D1
database, or the one that `--database` names. With `--tables core` (the
default), the binding's `migrations_dir` must hold every file of
`@authtempo/adapter-d1` with the same text. Another folder stops the run
and names both folders, because wrangler would apply the wrong files and
report success. With `--tables compat`, the command copies each file of the
compatibility package into the app's `migrations_dir` under the app's next
number, then applies. The files are those of `migrations/d1/`, or of
`migrations/d1-before-1.7/` with `--before-1.7`. It reads `compat_better_auth` of `ta_meta` first,
and copies no compat file at or below that version. A file whose text the
folder holds is not copied again. A copy above that version with another
text stops the run with exit 2 before any write, and the line names the
file. The copied files hold Better Auth's default table and column names.
The shipped 0001, 0006, 0007, 0009, 0010, 0012, and 0013 fail on other names with
`no such table`. An app with other names writes its own thirteen files. It copies
0002 to 0005, 0008, and 0011 as shipped. It writes 0001 from
`storage.migrationSql()`, or from `storage.migrationSql("before-1.7")` for
tables from before 1.7. It writes 0006 from
`compatMigration0006Sql("sqlite", storage.names)`, and 0007 from
`compatMigration0007Sql("sqlite", storage.names)`. It writes 0009 from
`compatMigration0009Sql("sqlite", storage.names)`, and 0010 from
`compatMigration0010Sql("sqlite", storage.names)`. For tables from before
1.7, `compatMigration0010Sql` takes `"before-1.7"` as a third argument.
It writes 0012 from `compatMigration0012Sql("sqlite", storage.names)`, and
0013 from `compatMigration0013Sql("sqlite", storage.names)`.
Tables that hold `session.activeTeamId` and `invitation.teamId` already
(Better Auth's `teams` option) need an own 0010, also with the default
names. It is the 0010 text without its two `ADD COLUMN` lines of `session`
and `invitation`. Without it, the 0010 fails with
`duplicate column name: activeTeamId`. Tables that hold the columns of
Better Auth's username, phone number, or anonymous plugin need an own
0012 without the `ADD COLUMN` line of each column that they hold, and
without the unique key that they hold. The
app applies its own files with `wrangler d1 migrations apply <database>`
before this command. Then the compat version is 13, and the command copies
nothing. Without `--remote`, the run is on
the local database of `wrangler dev`. wrangler records each applied file in
its table `d1_migrations` (`migrations_table`).

## import

```bash
authtempo import supabase --users users.csv --identities identities.csv \
  --formats bcrypt --target postgres --url-env DATABASE_URL --dry-run
```

The readers, the report, and the exit codes are those of
`@authtempo/import` (its README names every flag of each provider). The
flag map from the old binary:

| `authtempo-import` | `authtempo import` |
| --- | --- |
| `--postgres <url>` | `--target postgres` with `--url-env <NAME>` (default `DATABASE_URL`) or `--url-file <path>` |
| `--better-auth` | `--tables compat` (default `core`) |
| `--d1-bundle <file>` | `--target d1-bundle --out <file>` |
| `--tables <file>` (Auth.js) | `--authjs-tables <file>` |
| `--firebase-signer-key <value>` | `--firebase-signer-key-env <NAME>` or `--firebase-signer-key-file <path>` |
| every other flag | the same name and meaning |

`--json` prints `{ report, stopped, bundle, verify, exit }`: the report is
the JSON of `--report <file>`, and `verify` is the answer of `import verify`,
else null.

## The alias authtempo-import

`authtempo-import` stays for one release with its old flags and usage text.
It prints one deprecation line on stderr, and with `--postgres` a second
line, because a connection string on the command line goes into the shell
history and the process list.

## check

```bash
authtempo check https://api.example.com
```

Nine checks, each `pass`, `fail` with a code, or `skip` with a reason:
`https`, `mount` (`GET <basePath>/session` answers 401 JSON),
`origin_rule` (a POST from `https://check.invalid` answers 403), `cookie`
(the clear cookie of a sign-out is HttpOnly, Secure, and `Path=/`), `jwks`
(public keys only, EdDSA, ES256, or RS256, `use: "sig"`, a cache header),
`well_known` (both documents at the origin root name the issuer and the
key set), `schema_version`, `schema_shape`, and `ready`. The check `ready`
reads `GET <basePath>/health`, which answers 200, and then
`GET <basePath>/ready`, which answers 200 when the app turns on
`observe.readiness`. It skips with `readiness_off` when that route answers
404. The two schema checks need
`--target` and the inputs of the database. `schema_shape` compares each
`ta_` table with the shape that the adapter's migrations make
(`expectedPostgresShape`, `expectedD1Shape`). A missing table, column, or
unique index fails, and so does a column of another type or NOT NULL rule.
A missing plain index, an extra column, and an extra table warn. On a
database with the Better Auth compatibility tables, it skips with
`compat_database`. A skip never counts as a pass. `--strict` counts it as
a failure, except the skip `compat_database`, which no fix clears. The
command reads public documents only. The first JWKS read of a new database
writes its first signing key, which is core's own rule.
`runChecks` is exported and imports no Node.js module, so a Worker test can
run it. `src/checks.ts` lists every code in `CHECK_CODES`.

## keys rotate

```bash
authtempo keys rotate https://api.example.com --yes
```

It calls `POST <basePath>/operator/keys/rotate` of core with
`Authorization: Operator <secret>`, and prints `kid: <kid>`. The deployment
needs `operator: { secretHash }` in its config, the SHA-256 hex of the
secret. The old key verifies for 24 hours and signs nothing. With no
terminal the command needs `--yes`; it reads the key set before and after,
and warns when a cache still serves the old set.

## mcp

```bash
authtempo mcp --claude-code
```

It adds the authtempo MCP server to the config of an editor in this
project. The editor flags are `--claude-code`, `--cursor`, `--codex`,
`--opencode`, and `--vscode`. `--manual` prints each entry and writes no
file. The file holds the name of the variable of `--url-env`, never its
value. The command stops, and writes nothing, on another authtempo entry or
on a file that does not parse. `--remote` uses the remote docs server.
`-n`, `--dry-run` prints the new text and writes nothing.

## secret

```bash
authtempo secret --version 2 --out secret-v2.txt
authtempo secret --operator
```

It makes an app secret (`--version <n>`) or an operator secret
(`--operator`) from 32 bytes of the Web Crypto source, as 43 characters of
base64url. It draws again when core's `entropyBits` would warn on a value.
The value goes out once: one stdout line, or one new file with mode 0600
with `--out`. The command replaces no file, follows no link, and keeps no
copy. `--operator` also prints the SHA-256 for `operator.secretHash`.

## secret status and secret rewrap

```bash
authtempo secret status https://api.example.com
authtempo secret rewrap https://api.example.com --yes
```

`secret status` calls `GET <basePath>/operator/secrets/status` and prints
the row counts of each app secret version. It exits 1 when a version that
the config does not hold has rows. `secret rewrap` calls
`POST <basePath>/operator/secrets/rewrap` and sends each `next` back as
`after`. It ends when no row of an old version remains, when a pass ends,
or at `--max-calls`. `--call-budget <n>` (50 to 1000, default 50) sets
the storage calls of one call on D1 Paid or Postgres. With no terminal it
needs `--yes`. Both send the
operator secret only, never the app secret. The deployment reseals each
row and answers counts only. The two routes and `info` share the limit
`operator-secrets:ip:<ip>`, 120 calls an hour.

## info

```bash
authtempo info https://api.example.com --target postgres
```

It prints a support report in four parts: the tools, the project, the
database (with `--target`), and the deployment. The deployment part needs
a base URL, and reads `GET <basePath>/operator/info`. The report holds no
secret value and no host name. The deployment answers config key paths,
never a value, and the command drops each path that is not a plain name.
Exit 1 names a part that gave no answer.

## users, sessions, audit, and create-admin

```bash
authtempo users search https://api.example.com --email ada@example.com
authtempo users ban https://api.example.com <user id> --reason "spam" --yes
authtempo users create https://api.example.com --email ada@example.com --reason "ticket 4710" --yes
authtempo users update https://api.example.com <user id> --name "Ada Lovelace" --reason "ticket 4711" --yes
authtempo users delete https://api.example.com <user id> --reason "request 4713"
authtempo sessions end-all https://api.example.com --reason "breach" --yes
authtempo audit list https://api.example.com --all
authtempo create-admin https://api.example.com --email root@example.com --reason "first operator" --yes
```

These commands call the operator user tools of plan 12f (spec 26 item 11)
under `<basePath>/operator/`. The deployment needs `operator.users` and a
named secret in `operator.secrets` with the scope of each command: `users`
for `users` and `create-admin`, `sessions` for `sessions`, and `audit` for
`audit`. `users delete` needs the `delete` scope beside `users` (plan
12f2). The operator secret comes from `--token-env` or `--token-file`
only, as for `keys rotate`.

- `users list|search|get` and `audit list` print a table on stdout, or one
  JSON document with `--json`. `--all` follows `next` until it is null,
  with pages of 100 rows, up to `--max-calls` (100 by default, then exit 1
  and a warning). A `next` that does not move, or a stop after the first
  page, stops with exit 2. The command then prints the rows read before it.
- `users ban|unban|platform-role|second-factor-off|create|update|delete`,
  `sessions end|end-all`, and `create-admin` need `--reason`. The CLI checks it before any request.
  It is 1 to 500 UTF-16 code units with no control character, line or
  paragraph separator, lone surrogate, or format character except U+200C and
  U+200D. With no terminal, or with
  `--no-input`, they need `--yes`. Each `users` write and `create-admin`
  writes one audit row, and the command prints its id.
- `users create` takes exactly one of `--email` and `--phone`, and
  `--name`, `--image`, `--verified`, and `--first-sign-in invite|reset|none`.
  It sets no password. It prints the user id on stdout, and the audit row
  id and the next step of the person on stderr. No line holds the address,
  the phone number, or a token. A link that the deployment failed to mail
  gives a `warning:` line and exit 1; the user stays. Each call also counts
  on `operator-create:actor:<kind>:<id>`, 200 calls an hour for one actor.
- `users update` takes `--name`, `--no-name`, `--image`, and `--no-image`,
  at least one. It sends no address and no password. With `--json` it
  prints the user after the change.
- `users delete` cannot be undone. Without `--yes` it asks for the user
  id, and only the typed user id deletes the account. It prints each
  organization that went with the account. Each call also counts on
  `operator-delete:actor:<kind>:<id>`, 100 calls an hour for one actor.
- A ban or a revoke that answers `familyEndFailed: true` prints its line,
  then a `warning:` line on stderr, and exits 1. The act ran, and the end of
  the OAuth refresh families failed. `sessions end` for the user ends them.
- `sessions end` and `sessions end-all` write one audit row for each call.
  In text mode they print no audit row id. `sessions end --json` lists the
  ids in `auditIds`; the document of `sessions end-all --json` has no ids.
- `sessions end` and `sessions end-all` call again while the answer has
  `more: true`, up to `--max-calls`, with one stderr line per call.
- No stderr line holds an address. An address on stdout is the result that
  the operator asked for. No line holds the secret.
- A 404, a 401, a 403, and a 429 stop with exit 2 and a text that names the
  cause. Every secret call counts on `operator-users:ip:<ip>`, 600 calls an
  hour, right or wrong secret.

## Tests

The child-process tests run `dist/bin/authtempo.js`. `test/support/bin.ts`
fails a run when the build is older than `src/`, and `packages/cli/turbo.json`
builds the package before its test. `node proof/pack-files.mjs` proves that a
pack holds `dist/`, `package.json`, and this README only.
