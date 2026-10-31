---
"@authtempo/adapter-sqlite": patch
---

The copy script of the SQLite adapter writes its migration module only when the bytes change. So a typecheck after the build no longer makes the source newer than the build.
