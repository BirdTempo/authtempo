---
"@authtempo/core": minor
---

Breaking: a `social.oauth2` entry named `microsoft` or `discord` now fails at `createAuth`, because each name is a preset. Use the presets `social.microsoft` and `social.discord`. A `social.oidc` entry with such a name fails too, and so do the names `gitlab`, `slack`, `twitter`, and `facebook`.

The `microsoft` preset keys each identity on `oid`, the key that Better Auth keeps.
