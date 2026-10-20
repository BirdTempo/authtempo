# The D1 import

Runs `importUsers` against a D1 database on your own machine: through
core's D1 adapter for `TARGET=core`, or through the compatibility package's
D1 storage for `TARGET=compat`. The Worker has no fetch handler, so it serves no route.

WARNING: Do not deploy this Worker. A deploy uploads the input file, with the
password hashes, to Cloudflare. The config sets no workers.dev URL, no preview
URL, and no route, and the Worker refuses to run without `--var
LOCAL_IMPORT:1`. These limit a deploy. They do not stop the upload.

The Worker writes one of two sets of tables, chosen by the `TARGET` var:

- `core` (the default): core's tables, through core's D1 adapter.
- `compat`: an app's Better Auth 1.7 tables, through
  `@authtempo/compat-better-auth` (`betterAuthSchemaStorage`), the same
  mapping that the app's `betterAuth` serves with Better Auth's default table
  and column names. It serves the default names only. An app with custom
  names (for example snake_case columns or plural tables) has no Worker path
  yet; do not run `compat` on it. The ready check reads only the unique
  index on the account table's (issuer, accountId). A custom name of that
  table or of those columns refuses with `schema_mismatch` before any write
  (`test/d1/import-d1-compat-names.test.ts`). Any other custom name passes
  the check, and the run stops with a D1 error at the first statement on
  that table: the failing record writes no row, and the records before it
  stay. The database must hold the compatibility migrations first (step 2).

Any other value stops the Worker at start, and it writes nothing.

The Worker reads `input/import.local.json`. That file is git-ignored, because
it holds the password hashes and any Firebase signer key. The tracked
`input/import.json` is a sample with no user in it: a dry run of an empty
Supabase export. The D1 tests use the sample.

Run every command from `packages/import/worker`.

1. Choose the database. In `wrangler.jsonc`, set `database_name` and
   `database_id` to the app's database. To import into the real database, add
   `"remote": true` to the binding now, before the dry run. Without it, every
   step below uses the local copy in `.wrangler/state`, and the dry run
   reports on that copy, not on the real database.
2. Make sure the database has core's schema. A database below core's schema
   version refuses every write with `schema_mismatch`.
   - The real database (`"remote": true`): the app's migrations apply core's
     schema. In the app's folder, list them and apply any that is pending:

     ```bash
     pnpm exec wrangler d1 migrations list <database_name> --remote
     pnpm exec wrangler d1 migrations apply <database_name> --remote
     ```

   - The local copy (a rehearsal): apply core's migrations here. This config's
     `migrations_dir` is core's:

     ```bash
     pnpm exec wrangler d1 migrations apply <database_name> --local
     ```

   - For `TARGET=compat`, apply the compatibility package's migrations in the
     app's folder, not core's: `migrations/d1/` of
     `@authtempo/compat-better-auth` for Better Auth 1.7 tables, or
     `migrations/d1-before-1.7/` for older tables (its README). The Worker
     refuses with `schema_mismatch` until they are applied.

3. Write the input as a dry run. Use the same flags as a Postgres run, with
   `--target d1-bundle --out <file>` in place of `--target postgres`. A pack holds no
   `input` folder (it can hold the hashes), and the CLI does not make one, so
   make it first in an installed copy:

   ```bash
   mkdir -p input
   authtempo import supabase --users users.csv --identities identities.csv \
     --formats bcrypt,argon2id --target d1-bundle --out input/import.local.json --dry-run
   ```

4. Start the Worker. The build fails until `input/import.local.json` exists.

   ```bash
   pnpm exec wrangler dev --test-scheduled --ip 127.0.0.1 --var LOCAL_IMPORT:1
   ```

   For the Better Auth tables, add `--var TARGET:compat`:

   ```bash
   pnpm exec wrangler dev --test-scheduled --ip 127.0.0.1 --var LOCAL_IMPORT:1 --var TARGET:compat
   ```

   WARNING: Do not set `--ip 0.0.0.0`. Any machine on your network can then
   start the import.

5. In a second terminal, start the run. The path exists only in wrangler dev:

   ```bash
   curl "http://127.0.0.1:8787/__scheduled"
   ```

   Read the report in the first terminal. It is one line:

   ```text
   {"authtempoImport": {...}, "target": "core", "status": 0, "verify": null}
   ```

   `target` is `core` or `compat`. `status` is the CLI's exit status: 1
   means a person must look at the report. `verify` is null for an import,
   and the verify of a verify bundle (step 7). A run without
   `--var LOCAL_IMPORT:1` prints an error and writes nothing.
6. When the dry run report is correct, run step 3 again without `--dry-run`.
   Do not stop wrangler dev: it rebuilds when the input file changes. Wait for
   the rebuild line, then run step 5 again. A second real run changes zero
   rows, and its report lists each user as `exists`.
7. To check a run, write a bundle with `authtempo import verify … --target
   d1-bundle --out input/import.local.json`, and run the Worker again.
   `verify.held` true and status 0 mean that the database holds the export.
   The bundle carries `verify: true` and `options.dryRun: true`, so the run
   reads only. A verify bundle without `dryRun: true` is refused before any
   read.
8. WARNING: Delete `input/import.local.json` when you finish. It holds the
   password hashes. After a rehearsal on the local copy, also delete
   `.wrangler/state`: the local database in it holds the imported hashes.

The Worker imports `@authtempo/import`, the package's public entry, and the
D1 adapter, so it builds the same from this repo and from an installed
package. It runs with Node.js compatibility off: `proof/bundle-no-node.mjs`
bundles it with both flags, fails on any `node:` module, and fails unless the
bundle reads the package's `dist`. `proof/pack-files.mjs` checks the file
list of a pack against the allowlist in `files` (`dist`, this README,
`wrangler.jsonc`, `src`). It fails on any other path, and on any
path under `.wrangler/` (the local D1 copy and the dev bundle, both with the
hashes) or `input/`. The package's `test` script runs both. The proofs run
in this repo only: `bundle-no-node.mjs` compares `dist` with `src/`, and
`pack-files.mjs` packs the package folder, and no pack holds `src/`. No
pack holds the proofs either. The git history is the record of what they
checked.

Unverified (the owner runbook): a run against the real database with
`"remote": true`, and a run with an input file of tens of megabytes.
