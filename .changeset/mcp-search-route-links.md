---
"@authtempo/mcp": patch
---

In `docs.search`, a route link in a table row adds no token to the score of its section. The other words of the row still count. So a longer list of route links does not move its section up. `docs.read` still answers each link.
