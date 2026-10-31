---
"@authtempo/core": patch
"@authtempo/mcp": patch
---

Security: Take zod 4.6.6 in core and the MCP server. zod below 4.6.6 can exhaust memory when it validates an oversized constrained collection (GHSA-mrhx-c7xc-m3w5).
