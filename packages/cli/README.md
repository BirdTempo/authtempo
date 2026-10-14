# @authtempo/cli

The `authtempo` command line: set up, migrate, import into, check, and
maintain an authtempo deployment. Spec section 19 holds its rules.

```bash
authtempo --help
authtempo help <command>
```

## Install

The packages are not on a registry yet: publication is the owner's call.
In this repo, `examples/worker` has the CLI as a dev dependency, so pnpm
links the `authtempo` binary there: build it with
`pnpm --filter @authtempo/cli build`, then run
`pnpm --filter authtempo-example-worker exec authtempo --help`, or
`node packages/cli/dist/bin/authtempo.js`. After the first
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
the run, and nothing is written. Until the packages are on a registry, a
scaffold installs only inside this workspace.

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
`@authtempo/adapter-d1` with the same text: another folder stops the run
and names both folders, because wrangler would apply the wrong files and
report success. With `--tables compat`, the command copies each file of the
compatibility package (`migrations/d1/`, or `migrations/d1-before-1.7/` with
`--before-1.7`) into the app's `migrations_dir` under the app's next
number, then applies. A file whose text the folder holds is not copied
again. Without `--remote`, the run is on the local database of
`wrangler dev`. wrangler records each applied file in its table
`d1_migrations` (`migrations_table`).

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

## check

```bash
authtempo check https://api.example.com
```

Seven checks, each `pass`, `fail` with a code, or `skip` with a reason:
`https`, `mount` (`GET <basePath>/session` answers 401 JSON),
`origin_rule` (a POST from `https://check.invalid` answers 403), `cookie`
(the clear cookie of a sign-out is HttpOnly, Secure, and `Path=/`), `jwks`
(public keys only, EdDSA or ES256, `use: "sig"`, a cache header),
`well_known` (both documents at the origin root name the issuer and the
key set), and `schema_version` (with `--target` and the inputs of the
database). A skip never counts as a pass; `--strict` counts it as a
failure. The command reads public documents only; the first JWKS read of
a new database writes its first signing key, which is core's own rule.
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

## Tests

The child-process tests run `dist/bin/authtempo.js`. `test/support/bin.ts`
fails a run when the build is older than `src/`, and `packages/cli/turbo.json`
builds the package before its test. `node proof/pack-files.mjs` proves that a
pack holds `dist/`, `package.json`, and this README only.
