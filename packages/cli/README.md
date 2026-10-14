# @authtempo/cli

The `authtempo` command line: set up, migrate, import into, check, and
maintain an authtempo deployment. Spec section 19 holds its rules.

```bash
authtempo --help
authtempo help <command>
```

## Install

The packages are not on a registry yet: publication is the owner's call.
In this repo, no package depends on the CLI, so pnpm links no
`authtempo` binary: build it with `pnpm --filter @authtempo/cli build`,
then run `node packages/cli/dist/bin/authtempo.js`. After the first
release, install it with `pnpm add -D @authtempo/cli`, or run it with
`pnpm dlx @authtempo/cli`.

## The rules

- Exit codes: 0 done; 1 a person must look (a failed check, an import
  record that needs a person); 2 a usage error, a malformed input, or a
  stop. A stop prints one `stopped:` line on stderr.
- stdout holds the result. Usage errors, warnings, the `stopped:` line,
  and each line that names a host, a database, or a file that the command
  reads or writes go to stderr. `--json` prints one JSON document on stdout;
  `src/json.ts` exports each shape.
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

`--json` prints `{ report, stopped, bundle }`: the report is the JSON of
`--report <file>`.

## The alias authtempo-import

`authtempo-import` stays for one release with its old flags and usage text.
It prints one deprecation line on stderr, and with `--postgres` a second
line, because a connection string on the command line goes into the shell
history and the process list.

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

## Tests

The child-process tests run `dist/bin/authtempo.js`. `test/support/bin.ts`
fails a run when the build is older than `src/`, and `packages/cli/turbo.json`
builds the package before its test. `node proof/pack-files.mjs` proves that a
pack holds `dist/`, `package.json`, and this README only.
