---
"@authtempo/adapter-postgres": minor
"@authtempo/compat-better-auth": minor
"@authtempo/cli": patch
---

The peer range of `postgres` is now `^3.4.9 || ^4.1.1`. An app can bring postgres.js 4.1.1 or later. The tests of both packages run on 3.4.9 and on 4.1.1.

Versions 4.0.0 and 4.1.0 are outside the range. 4.1.0 sends a query through Hyperdrive that never answers. Before 4.1.1, a late statement of `sql.begin` can write after a rollback.

Each function of the adapter now takes a `PostgresClient`, a type of the adapter that names only the calls it makes. The `Sql` types of the two majors do not fit each other, and the client of each major fits this type. The compat storage takes the same type.

The Worker example for Postgres uses 4.1.1 and has a test that runs it in workerd. No test runs the Hyperdrive service yet.

`authtempo init --stack workers-postgres` copies that example. So a new app of that stack gets `postgres` 4.1.1 and the workerd test. The CLI itself still connects with 3.4.9.

Major 4 of postgres.js changes how the driver types a parameter. Read its upgrade guide for your own queries on the same client.
