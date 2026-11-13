# @authtempo/cli

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
