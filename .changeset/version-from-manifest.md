---
"@authtempo/core": patch
"@authtempo/mcp": patch
---

Core and the MCP server answer the version of their own package. This value is in `GET /operator/info`, in the OpenAPI document, and in the server info and the `version` tool of the MCP server. The build writes it from `package.json`, so it changes with each release.
