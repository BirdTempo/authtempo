# @authtempo/mcp

## 0.1.0

### Patch Changes

- 8884e61: In `docs.search`, a route link in a table row adds no token to the score of its section. The other words of the row still count. So a longer list of route links does not move its section up. `docs.read` still answers each link.
- 49a63d9: Raise the Node floor in `engines` to 22.13. Each of the three packages needs a package with that floor: mcp needs the CLI, compat-better-auth needs the SQLite adapter, and import needs compat-better-auth.
- 48a2484: Each package names its Node floor in `engines` and lists `CHANGELOG.md` in `files`. The floor is Node 22, or the higher floor that the package already had.
- ba9405b: Core and the MCP server answer the version of their own package. This value is in `GET /operator/info`, in the OpenAPI document, and in the server info and the `version` tool of the MCP server. The build writes it from `package.json`, so it changes with each release.
- d3cc382: Security: Take zod 4.6.6 in core and the MCP server. zod below 4.6.6 can exhaust memory when it validates an oversized constrained collection (GHSA-mrhx-c7xc-m3w5).
- Updated dependencies [552820d]
- Updated dependencies [8a8c319]
- Updated dependencies [e770fa4]
- Updated dependencies [901654f]
- Updated dependencies [b4cd250]
- Updated dependencies [363963e]
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
- Updated dependencies [d7f436f]
- Updated dependencies [48a2484]
- Updated dependencies [108fbf5]
- Updated dependencies [8953ed5]
- Updated dependencies [f9781f3]
- Updated dependencies [ba9405b]
- Updated dependencies [48a2484]
- Updated dependencies [d3cc382]
  - @authtempo/core@0.1.0
  - @authtempo/cli@0.1.0
