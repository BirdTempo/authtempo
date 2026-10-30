---
"@authtempo/core": patch
"@authtempo/mcp": patch
---

Core and the MCP server now take zod 4.6.6. zod below 4.6.6 can exhaust memory when it validates an oversized constrained collection (GHSA-mrhx-c7xc-m3w5).
