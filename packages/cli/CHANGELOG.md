# @authtempo/cli

## 0.2.0

### Minor Changes

- 91c6bca: Add the command `authtempo audit export <base url> --organization <id> --format ndjson|csv`. It reads each page of `GET /operator/audit` for one organization with the operator secret, up to `--max-calls`. It writes one row per line to stdout. A CSV file starts with a header line and uses RFC 4180 quotes. A CSV cell that starts with `=`, `+`, `-`, `@`, a tab, or a carriage return starts with `'`, so a spreadsheet runs no formula. A spreadsheet with `;` as its list separator splits the line at each `;`, also inside quotes. So a `'` also goes after each `;` and each line break in a cell, before one of those characters. It also goes there before a quote or the cell end. The command takes no `--json`, because stdout holds the export. The rows of `audit list --json` now hold `organizationId`. A deployment before schema version 18 answers no such key, and the CLI then gives null.
- 1a22e8a: Breaking: the binary `authtempo-import` is removed. Run `authtempo import` instead.
  
  In place of `--postgres <url>`, give `--target postgres` with `--url-env <NAME>` or `--url-file <path>`. In place of `--d1-bundle <file>`, give `--target d1-bundle --out <file>`.
- d2be91f: Compat migration 0014 serves core's schema version 17. It adds `ta_sso_setup_link`, `ta_sso_test_run`, and `ta_sso_setup_session`. It adds `draft` (default false), `version` (default 1), and `setup_link_id` to `ta_sso_connection`, `setup_link_id` to `ta_sso_domain`, and `pending` (default false) and `setup_link_id` to `ta_scim_token`. It changes no row. The text names `ta_` tables only, so it is the same for every naming. The new export is `compatMigration0014Sql`.
  
  Apply 0014 before you deploy core at version 17.
  
  The CLI knows schema version 17 and compat version 14. `authtempo migrate --target d1 --tables compat` copies 0014, and `authtempo generate` writes the three new models.
- c657924: Compat migration 0015 serves core's schema version 18. It adds `organization_id` to `ta_operator_audit`. It adds `certificate_ends_at`, `expiry_stage`, `expiry_notice_at`, `last_success_at`, `last_failure_at`, and `last_failure_step` to `ta_sso_connection`. It adds `expiry_stage` and `expiry_notice_at` to `ta_scim_token` and `ta_sso_setup_link`. Each new column is nullable with no default, and the migration changes no row. The text names `ta_` tables only, so it is the same for every naming. The new export is `compatMigration0015Sql`.
  
  Apply 0015 before you deploy core at version 18.
  
  The shim refuses a Better Auth `ac` resource named `audit`, as it refuses `apiToken`. Core 18 owns `audit`, the organization audit. Give the app's resource another name. Core ignores the `audit` key of each stored row of `organizationRole.permission`, so an old dynamic role grants no `audit:read`. A role create or update that names `audit` answers `INVALID_RESOURCE`.
  
  The role `owner` now holds core's `audit:read`, as core's owner rank does. So an owner reads `GET /organizations/audit`, and each other role gets `forbidden_rank`. A role statement that names `audit` is refused at start.
  
  The CLI knows schema version 18 and compat version 15. `authtempo migrate --target d1 --tables compat` copies 0015, and `authtempo generate` writes the new columns.

### Patch Changes

- f6ce98f: The peer range of `postgres` is now `^3.4.9 || ^4.1.1`. An app can bring postgres.js 4.1.1 or later. The tests of both packages run on 3.4.9 and on 4.1.1.
  
  Versions 4.0.0 and 4.1.0 are outside the range. 4.1.0 sends a query through Hyperdrive that never answers. Before 4.1.1, a late statement of `sql.begin` can write after a rollback.
  
  Each function of the adapter now takes a `PostgresClient`, a type of the adapter that names only the calls it makes. The `Sql` types of the two majors do not fit each other, and the client of each major fits this type. The compat storage takes the same type.
  
  The Worker example for Postgres uses 4.1.1 and has a test that runs it in workerd. No test runs the Hyperdrive service yet.
  
  `authtempo init --stack workers-postgres` copies that example. So a new app of that stack gets `postgres` 4.1.1 and the workerd test. The CLI itself still connects with 3.4.9.
  
  Major 4 of postgres.js changes how the driver types a parameter. Read its upgrade guide for your own queries on the same client.
- Updated dependencies [c79bf6c]
- Updated dependencies [996480b]
- Updated dependencies [d2be91f]
- Updated dependencies [c657924]
- Updated dependencies [d182103]
- Updated dependencies [e386ff8]
- Updated dependencies [227d5c6]
- Updated dependencies [ee41ba3]
- Updated dependencies [b456151]
- Updated dependencies [bc4768d]
- Updated dependencies [8b3ccc6]
- Updated dependencies [2c2dcbd]
- Updated dependencies [7aa0599]
- Updated dependencies [1a22e8a]
- Updated dependencies [5a0384d]
- Updated dependencies [1b83f8c]
- Updated dependencies [04792aa]
- Updated dependencies [d64537a]
- Updated dependencies [1a22e8a]
- Updated dependencies [f6ce98f]
- Updated dependencies [01e1b69]
- Updated dependencies [35325a9]
- Updated dependencies [4d41f15]
  - @authtempo/core@0.2.0
  - @authtempo/adapter-d1@0.2.0
  - @authtempo/adapter-postgres@0.2.0
  - @authtempo/adapter-mysql@0.2.0
  - @authtempo/adapter-sqlite@0.2.0
  - @authtempo/compat-better-auth@0.2.0
  - @authtempo/import@0.2.0
  - @authtempo/legacy-hashes@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - @authtempo/core@0.1.1
  - @authtempo/adapter-d1@0.1.1
  - @authtempo/adapter-mysql@0.1.1
  - @authtempo/adapter-postgres@0.1.1
  - @authtempo/adapter-sqlite@0.1.1
  - @authtempo/compat-better-auth@0.1.1
  - @authtempo/import@0.1.1
  - @authtempo/legacy-hashes@0.1.1

## 0.1.0

### Minor Changes

- b4cd250: A published scaffold takes the CLI as a dev dependency and runs each authtempo step with pnpm exec.
- 363963e: Add `authtempo upgrade`: it moves every authtempo package of an app to one version and prints the Breaking lines, the deprecations, and the migrate step.

### Patch Changes

- e770fa4: The transport rule of `migrate` and `check` now reads each form of the IPv6 loopback address `::1` as a loopback host. A libSQL URL such as `http://[0:0:0:0:0:0:0:1]:8080` no longer needs TLS. Another IPv6 address still needs TLS, and so does an IPv4-mapped address such as `::ffff:127.0.0.1`.
  
  The rule now refuses a MySQL host that is an IP address but not a loopback address, even with TLS. mysql2 checks the name `localhost` against the certificate of an IP host, so the URL must use the DNS name that the certificate carries.
- 901654f: The transport rule of `migrate` and `check` now reads a host with a tab, LF, or CR as no loopback host. mysql2 decodes such a character in the URL, such as `%09` in `mysql://u:p@%3A%3A%091/db`. That host now needs TLS, as any other remote host does.
  
  An IPv4 address with a leading zero in an octet, such as `127.0.0.08`, is no loopback host either. Such a host needs TLS too.
- d7f436f: The Node server of the `node` and `bun` scaffolds of `authtempo init` now rejects its promise when the listen fails. An example is a port that another process holds. Before this change, the error ended the process, and the test of the scaffold left its database. The test of the scaffold now tries at most three ports, and it tries a new port only when the listen fails with `EADDRINUSE`. When all three ports are in use, its failure line names the last port, not Postgres.
- 48a2484: Each package names its Node floor in `engines` and lists `CHANGELOG.md` in `files`. The floor is Node 22, or the higher floor that the package already had.
- Updated dependencies [a1c5ad8]
- Updated dependencies [552820d]
- Updated dependencies [8a8c319]
- Updated dependencies [48a2484]
- Updated dependencies [b8b54a4]
- Updated dependencies [abf1b79]
- Updated dependencies [d4bc280]
- Updated dependencies [28f0699]
- Updated dependencies [3f1c11c]
- Updated dependencies [762c5c3]
- Updated dependencies [d9fe45b]
- Updated dependencies [30e85d8]
- Updated dependencies [f513359]
- Updated dependencies [7762d73]
- Updated dependencies [39e5ca1]
- Updated dependencies [0347b96]
- Updated dependencies [b8b54a4]
- Updated dependencies [e239c83]
- Updated dependencies [28f0699]
- Updated dependencies [b6da6a3]
- Updated dependencies [552820d]
- Updated dependencies [abf1b79]
- Updated dependencies [f82781f]
- Updated dependencies [d9fe45b]
- Updated dependencies [30e85d8]
- Updated dependencies [a1c5ad8]
- Updated dependencies [f9e9b1d]
- Updated dependencies [f2f1af1]
- Updated dependencies [da31e0f]
- Updated dependencies [49a63d9]
- Updated dependencies [48a2484]
- Updated dependencies [108fbf5]
- Updated dependencies [8953ed5]
- Updated dependencies [db69d5f]
- Updated dependencies [f9781f3]
- Updated dependencies [ba9405b]
- Updated dependencies [48a2484]
- Updated dependencies [d3cc382]
  - @authtempo/adapter-d1@0.1.0
  - @authtempo/adapter-sqlite@0.1.0
  - @authtempo/compat-better-auth@0.1.0
  - @authtempo/core@0.1.0
  - @authtempo/adapter-postgres@0.1.0
  - @authtempo/adapter-mysql@0.1.0
  - @authtempo/import@0.1.0
  - @authtempo/legacy-hashes@0.1.0
