---
"@authtempo/cli": patch
---

The Node server of the `node` and `bun` scaffolds of `authtempo init` now rejects its promise when the listen fails, for example on a port that another process holds. Before this change, the error ended the process, and the test of the scaffold left its database. The test of the scaffold now tries a new port when the listen fails with `EADDRINUSE`, at most three times.
