# Differential findings against xml-crypto 6.3.3 (2026-10-20)

Two inputs give other canonical bytes in xml-crypto 6.3.3 than the W3C rules.
Core keeps the W3C form. The test rows "keeps the W3C sort order where
xml-crypto differs" pin the W3C output only (ruling 18 of plan 12d), and the
generator of the 200 Responses keeps out of these two inputs.

1. Namespace declarations. xml-crypto sorts the prefixes with
   `String.prototype.localeCompare`, so `xmlns:a` comes before `xmlns:Z`.
   Canonical XML 1.0 section 2.3 sorts by code point, so `xmlns:Z` comes first.
2. Attributes. xml-crypto sorts the namespaced attributes by the joined text
   of namespace URI and local name. When one URI is the start of the other
   (`http://www.w3.org/2001/XMLSchema` and `...XMLSchema-instance`, or `urn:a`
   and `urn:ab`), its order differs. Canonical XML 1.0 sorts by namespace URI
   first, then by local name.

An IdP whose canonicalizer follows the W3C rules and that writes such an input
verifies in core and fails in xml-crypto. No real fixture of SOURCE.md holds
either input.
