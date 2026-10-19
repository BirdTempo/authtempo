# The client ID metadata document fixtures

`oauth-cimd-02.test.ts` reads these files (plan 12e Task 6). No test fetches a draft. JSON has no comment, so each `_source` line is here.

Neither draft holds a full example document. Each draft shows a fragment with `...` only. So each fixture names where each member comes from.

- `draft-00.json` `_source`: the example document of the MCP 2026-07-28 client registration page (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration), which pins draft-ietf-oauth-client-id-metadata-document-00, section 4.1; fetched 2026-10-19. A copy, member for member.
- `draft-02.json` `_source`: draft-ietf-oauth-client-id-metadata-document-02 (6 July 2026), section 8.2, for `token_endpoint_auth_method` and `jwks_uri`; fetched 2026-10-19. The other members are the RFC 7591 section 2 fields of a code client. `client_id` and the redirect URI use the hosts of the core tests.

- `vscode.json` `_source`: the live metadata document of Visual Studio Code at https://vscode.dev/oauth/client-metadata.json (200, `application/json; charset=utf-8`); read 2026-10-20 00:01 CST. A copy, member for member, in the Biome format. It names the device grant, which core does not serve (ruling 24 of plan 12e).

The test gives `jwks_uri` a key that it generates, so no private key is in this folder.
