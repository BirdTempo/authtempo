---
"@authtempo/cli": patch
---

The Node server of the `node` and `bun` scaffolds of `authtempo init` now rejects its promise when the listen fails. An example is a port that another process holds. Before this change, the error ended the process, and the test of the scaffold left its database. The test of the scaffold now tries at most three ports, and it tries a new port only when the listen fails with `EADDRINUSE`. When all three ports are in use, its failure line names the last port, not Postgres.
