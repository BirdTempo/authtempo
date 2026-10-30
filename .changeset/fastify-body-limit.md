---
"@authtempo/fastify": patch
---

The plugin of the routes of core buffers a body of up to 8 MiB, the largest body cap of core, not Fastify's default of 1 MiB. Core answers the cap of each route with `body_too_large` (413), and a longer body gets the same code from the plugin.
