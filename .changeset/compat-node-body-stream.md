---
"@authtempo/compat-better-auth": patch
---

`toNodeHandler` gives core the request body as a stream with `duplex: "half"`, so the cap of each route bounds the bytes that the route reads. Before, the handler read every body byte into memory before the shim ran. So an anonymous caller on an SSO path got no 401 until the whole body came, and a body of 16 MiB was held whole.

A request that fails, such as one whose client drops the body, now closes its socket and throws nothing. Before, that rejection ended a `node:http` server.
