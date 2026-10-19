# Expected gaps of the local conformance run (plan 12e Task 17)

This list was written before any run. Each line names the module, its source file at the tag `release-v5.3.2` (commit `11999aad`), the reason, and the result to expect. The sources were read on 2026-10-20 as public pages of gitlab.com/openid/conformance-suite. Each path is under `src/main/java/net/openid/conformance/openid/`.

A module result that this list does not name, and that is not PASSED, stops the run: find its cause before the evidence line.

## Basic OP plan (`oidcc-basic-certification-test-plan`)

One run covers both secret methods. `OIDCCBasicTestPlan.java` runs 31 modules with `client_secret_basic`, then `oidcc-server-client-secret-post` with `client_secret_post`, then 6 more: 38 modules in all. The plan's "client_secret_basic, then client_secret_post" as two runs does not match this source.

| Module | Source file | Reason | Expected result |
| --- | --- | --- | --- |
| `oidcc-scope-address` | `OIDCCScopeAddress.java` | Core serves no `address` scope. The module skips when `scopes_supported` lacks it (`AbstractOIDCCReturnedClaimsServerTest.java`). | SKIPPED |
| `oidcc-scope-phone` | `OIDCCScopePhone.java` | Core serves no `phone` scope. The same skip rule. | SKIPPED |
| `oidcc-scope-all` | `OIDCCScopeAll.java` | It asks for `address` and `phone` beside `email` and `profile`. The same skip rule. | SKIPPED |
| `oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported` | `OIDCCUnsignedRequestObjectSupportedCorrectlyOrRejectedAsUnsupported.java`, `AbstractOIDCCRequestObjectServerTest.java` | Core refuses `request` with `request_not_supported` by redirect (OIDC Core 3.1.2.6). The module skips on that error. | SKIPPED |
| `oidcc-ensure-request-object-with-redirect-uri` | `OIDCCEnsureRequestObjectWithRedirectUri.java` | The outer `redirect_uri` is not registered, so core shows its error page and redirects nowhere. The module then asks for a screenshot of that page. | REVIEW |
| `oidcc-claims-essential` | `OIDCCClaimsEssential.java` | Core ignores the `claims` parameter (spec 8.16 item 16). Core sends `name` only with the `profile` scope, so userinfo can lack it. | PASSED or WARNING |
| `oidcc-ensure-request-without-nonce-succeeds-for-code-flow` | `OIDCCEnsureRequestWithoutNonceSucceedsForCodeFlow.java` | The module sends no `nonce` and no PKCE, and expects a code. Owner decision 3 of plan 12e lets a confidential client omit PKCE only with `openid` and a `nonce` (RFC 9700 section 2.1.1). So core answers `invalid_request` (ruling 52). | FAILED |

Not run with a static client: `oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported` (`OIDCCRequestUriUnsignedSupportedCorrectlyOrRejectedAsUnsupported.java`) and `oidcc-idtoken-unsigned` (`OIDCCIdTokenUnsigned.java`). Each carries `@VariantNotApplicable` for `static_client`.

## Config OP plan (`oidcc-config-certification-test-plan`)

`OIDCCConfigTestPlan.java` runs one module, `oidcc-discovery-endpoint-verification`, with discovery and a static client. No gap is expected.

## RP-initiated logout plan (`oidcc-rp-initiated-logout-certification-test-plan`)

`OIDCCRpInitiatedLogoutTestPlan.java` runs a discovery module and 10 logout modules. No gap is expected.

## Back-channel logout plan (`oidcc-backchannel-rp-initiated-logout-certification-test-plan`)

`OIDCCBackchannelRpInitiatedLogoutTestPlan.java` runs a discovery module and `oidcc-backchannel-rp-initiated-logout`. No gap is expected.

## Errata of the plan text

- The plan and its Task 17 brief say "spec 8.16 item 15 (not in 12e)". The "Not in 12e" list is spec 8.16 item 16.
- The suite never sends RFC 8707 `resource`. The conformance mode sets `oauth.defaultResource` for that (ruling 52); without it, every authorize request of the suite answers `invalid_target`.
