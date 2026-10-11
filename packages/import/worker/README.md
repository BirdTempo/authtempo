# The D1 import

Runs `importUsers` against a D1 database through core's D1 adapter, on your
own machine. The Worker has no fetch handler, so it serves no route.

1. Write the bundle. Use the same flags as a Postgres run, with `--d1-bundle`
   in place of `--postgres`. Run a dry run first:

   ```bash
   tempo-auth-import supabase --users users.csv --identities identities.csv \
     --d1-bundle packages/import/worker/input/import.json --dry-run
   ```

2. In `worker/wrangler.jsonc`, set `database_name` and `database_id` to the
   app's database. Apply the app's migrations to it first (`wrangler d1
   migrations apply`). A database below core's schema version refuses every
   write with `schema_mismatch`.
3. Start the Worker. `wrangler dev` uses the local copy in `.wrangler/state`.
   To write the real database, add `"remote": true` to the binding first.

   ```bash
   cd packages/import/worker
   pnpm exec wrangler dev --test-scheduled
   ```

4. In a second terminal, start the run. The path exists only in wrangler dev:

   ```bash
   curl "http://localhost:8787/__scheduled"
   ```

5. Read the report: one line `{"tempoAuthImport": {...}}` in the first
   terminal. Run step 1 again without `--dry-run`, then steps 3 and 4.
6. CAUTION: `input/import.json` now holds the password hashes. Do not commit
   it. When you finish, put back the committed dry run of an empty export, so
   the Worker still builds:

   ```bash
   git checkout -- packages/import/worker/input/import.json
   ```
