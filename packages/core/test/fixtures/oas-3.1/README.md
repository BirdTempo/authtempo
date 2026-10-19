# The OpenAPI 3.1 schema files

`openapi-valid.test.ts` validates the OpenAPI document of core against these files (plan 11g Task 8). The patch of the document is 3.1.2. Each file is a copy of its source, byte for byte.

No test fetches these files. Replace them only with a newer dated file of the same patch, and record the date here.

Read on 2026-10-19 from spec.openapis.org. Each `$id` equals its source URL.

| File | Source URL | SHA-256 |
| --- | --- | --- |
| `schema.json` | https://spec.openapis.org/oas/3.1/schema/2026-08-03 | `59f106413cb48c31299f96f024c938d3628aed6cd02cd14bcfb2fcaae7a130b6` |
| `schema-base.json` | https://spec.openapis.org/oas/3.1/schema-base/2026-08-03 | `ffdd07e28417bfa89de635d23a7476f7625497b8edd279f18c1424e613966d9a` |
| `dialect.json` | https://spec.openapis.org/oas/3.1/dialect/2024-11-10 | `647f32dfff64949d5020a28ecd1af4ffeffb1e9c695f861a52255a8004e07460` |
| `meta.json` | https://spec.openapis.org/oas/3.1/meta/2024-11-10 | `80706a9a404affedbf84ac4dc1328c9ce0d2a00804cdfc4d95c0ddd0053121dd` |

`schema-base.json` names `schema.json` and the base dialect `dialect.json`. The dialect names the base vocabulary `meta.json` and the draft 2020-12 meta-schema. Ajv's `Ajv2020` class holds the draft 2020-12 meta-schemas, so they are not here.

Ajv 8.20.0 resolves `$dynamicRef` only to a `$dynamicAnchor` at a schema root, and these files put the anchor `meta` under `$defs/schema`. So the test reads `schema.json` with each of its four `"$dynamicRef": "#meta"` as a static `$ref` to `schema-base.json#/$defs/schema`, in memory only (ruling 11 of plan 11g). The validation starts at `schema-base`, so dynamic resolution reaches that anchor too. Our document declares no dialect, so the default base dialect applies. `openapi-valid.test.ts` pins this target: a schema that names the draft 2020-12 dialect fails, at the top and nested. The test counts the four refs, so a new file with more or fewer fails.

The root `biome.json` excludes this folder. A format pass changes the bytes, and then the hashes above are false.

Check a hash with `shasum -a 256 packages/core/test/fixtures/oas-3.1/*.json` from the repository root.
