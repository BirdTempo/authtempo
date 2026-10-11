# The D1 import

Runs `importUsers` against a D1 database through core's D1 adapter, on your
own machine. The Worker has no fetch handler, so it serves no route.

WARNING: Do not deploy this Worker. A deploy uploads the input file, with the
password hashes, to Cloudflare. The config sets no workers.dev URL, no preview
URL, and no route, and the Worker refuses to run without `--var
LOCAL_IMPORT:1`. These limit a deploy. They do not stop the upload.

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

3. Write the input as a dry run. Use the same flags as a Postgres run, with
   `--d1-bundle` in place of `--postgres`:

   ```bash
   tempo-auth-import supabase --users users.csv --identities identities.csv \
     --d1-bundle input/import.local.json --dry-run
   ```

4. Start the Worker. The build fails until `input/import.local.json` exists.

   ```bash
   pnpm exec wrangler dev --test-scheduled --ip 127.0.0.1 --var LOCAL_IMPORT:1
   ```

   WARNING: Do not set `--ip 0.0.0.0`. Any machine on your network can then
   start the import.

5. In a second terminal, start the run. The path exists only in wrangler dev:

   ```bash
   curl "http://127.0.0.1:8787/__scheduled"
   ```

   Read the report: one line `{"tempoAuthImport": {...}}` in the first
   terminal. A run without `--var LOCAL_IMPORT:1` prints an error and writes
   nothing.
6. When the dry run report is correct, run step 3 again without `--dry-run`.
   Do not stop wrangler dev: it rebuilds when the input file changes. Wait for
   the rebuild line, then run step 5 again. A second real run changes zero
   rows, and its report lists each user as `exists`.
7. WARNING: Delete `input/import.local.json` when you finish. It holds the
   password hashes.

Unverified (the owner runbook): a run against the real database with
`"remote": true`, and a run with an input file of tens of megabytes.
