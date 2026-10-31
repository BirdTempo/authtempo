---
"@authtempo/compat-better-auth": patch
"@authtempo/import": patch
"@authtempo/mcp": patch
---

Raise the Node floor in `engines` to 22.13. Each of the three packages needs a package with that floor: mcp needs the CLI, compat-better-auth needs the SQLite adapter, and import needs compat-better-auth.
