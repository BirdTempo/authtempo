---
"@authtempo/core": patch
"@authtempo/client": patch
---

Core and the client declare vitest as an optional peer dependency. Their conformance kits import vitest, so a kit now loads in the test run of an adapter, a limiter, or an SDK. An app that does not run a kit installs nothing new.
