---
"@authtempo/fastify": patch
---

The plugin of the routes of core passes the raw body stream to core, and Fastify buffers none of it. Core reads at most the cap of each route. The cap is 64 KiB, 256 KiB for the Apple callback, and 8 MiB for the two SSO connection writes. Past it, core answers `body_too_large` (413) with its own headers. Fastify's `bodyLimit` takes no part.
