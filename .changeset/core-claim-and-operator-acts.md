---
"@authtempo/core": patch
---

A flow that claims an unverified address counts its claim retries apart from its unique-key retry. Before, a magic link, a social sign-in, a password reset, or an invitation confirm could answer 500. That happened after one unique-key retry, two session races, and one lost claim.
