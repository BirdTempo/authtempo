import { describe, expect, it } from "vitest";
import { EVENTS, type EventSpec, validateEvent } from "../src/observe/events.js";
import { STAMP_FIELDS } from "../src/observe/port.js";
import { FIELD_KINDS } from "../src/redact.js";

/**
 * From the grep of plan 12h Task 1 Step 1. A new line joins EVENTS and this list.
 * The list holds the 61 texts of the start list at 24c7237f. It also holds the
 * 2 texts of the 12k merge, read again at 91c26417. These are the waitUntil line
 * of 12h Task 2 and the role row line of 12k. Plan 12i Task 13 adds the
 * claims line of the social flow. Plan 12i Task 2 adds the username set
 * line, and Task 4 the line of the SMS port. A call that builds a text for
 * each value gives one text for each value. These are the email code and second-factor
 * counts, and the three sweep steps. A part that a field fills is written `<field>`.
 */
const START_LIST: readonly string[] = [
  "authtempo: the captcha port threw",
  "authtempo: the captcha did not answer",
  "authtempo: the SMS port threw",
  "authtempo: <path> has an estimated <bits> bits of entropy; 120 or more is recommended",
  "authtempo: account delete gave up",
  "authtempo: user patch refused",
  "authtempo: email change gave up",
  "authtempo: hook event copy failed",
  "authtempo: before hook failed",
  "authtempo: after hook failed",
  "authtempo: credential removal gave up",
  "authtempo: a signing key reseal failed",
  "authtempo: a signing key does not open under this secret; it retires",
  "authtempo: jwtMint.claims answered a value that is not an object",
  "authtempo: jwtMint.claims threw",
  "authtempo: notice mail failed",
  "authtempo: client metadata document refused",
  "authtempo: client metadata member dropped",
  "authtempo: client key set refused",
  "authtempo: client metadata document dropped its client auth; refresh tokens and device codes revoked",
  "authtempo: a back-channel logout is dropped after 6 attempts",
  "authtempo: a back-channel logout is dropped: the client refused it",
  "authtempo: a back-channel logout attempt failed",
  "authtempo: the back-channel logout delivery failed",
  "authtempo: the delete of a refresh row in a revoked grant failed",
  "authtempo: operator step failed",
  "authtempo: operator family end failed",
  "authtempo: operator ban write gave up",
  "authtempo: operator guard refused",
  "authtempo: operator read",
  "authtempo: passkey registration rejected",
  "authtempo: passkey credential already registered",
  "authtempo: passkey authentication rejected",
  "authtempo: passkey counter moved",
  "authtempo: profile update gave up",
  "authtempo: username set gave up",
  "authtempo: backup code spend gave up",
  "authtempo: backup code replacement gave up",
  "authtempo: a sealed value did not move to the current secret; it did not open, or a concurrent write changed it first",
  "authtempo: session patch refused",
  "authtempo: social client secret failed",
  "authtempo: social token request failed",
  "authtempo: social token endpoint answered",
  "authtempo: social token answer has no token",
  "authtempo: social id token rejected",
  "authtempo: social nonce mismatch",
  "authtempo: social user info failed",
  "authtempo: social user info has a bad subject",
  "authtempo: social id token claims refused",
  "authtempo: the sweep link step stopped",
  "authtempo: the sweep outbox step stopped",
  "authtempo: the sweep pending end step stopped",
  "authtempo: a TOTP secret reseal failed",
  "authtempo: user hold gave up",
  "authtempo: email code count gave up",
  "authtempo: second-factor challenge count gave up",
  "authtempo: unhandled error",
  "authtempo: operator route unauthorized",
  "authtempo: a stored value names secret version <version>, which is not configured",
  "authtempo: oidc discovery request failed",
  "authtempo: oidc discovery answered",
  "authtempo: oidc discovery is not JSON",
  "authtempo: oidc discovery issuer mismatch",
  "authtempo: oidc discovery lacks an endpoint",
  "authtempo: waitUntil threw; the flush has no hook",
  "authtempo: role row invalid <rowId>",
  // Plan 12g (ruling 7): the credential id bound of a passkey registration.
  "authtempo: passkey credential id over 1023 bytes",
  // Plan 12d, read again at the move onto main: the SSO lines and the two sweep steps of 12d.
  "authtempo: the sweep sso recheck step stopped",
  "authtempo: the sweep organization rest step stopped",
  "authtempo: sso guard refused",
  "authtempo: sso failed",
  "authtempo: sso denied",
  "authtempo: sso refused",
  "authtempo: saml certificate expired",
  "authtempo: an sso client secret did not open",
  "authtempo: sso domain unverified",
  "authtempo: sso domain lost",
];

/** Field names that can hold a secret, a credential, or free text (spec 31 item 8). */
const FORBIDDEN = [
  "token",
  "secret",
  "password",
  "email",
  "ip",
  "userAgent",
  "url",
  "message",
  "stack",
  "body",
  "next",
  "key",
  "cookie",
  "header",
];

const ENTRIES = Object.entries(EVENTS) as [string, EventSpec][];

describe("the event table (plan 12h Task 3, spec 31 items 6 and 7)", () => {
  it("has one row for each line of the start list", () => {
    const texts = ENTRIES.flatMap(([, spec]) => (spec.line ? [spec.line.text] : []));
    // 63 of plan 12h, 1 of plan 12g, 10 of plan 12d, and 3 of plan 12i.
    expect(START_LIST).toHaveLength(77);
    expect(texts).toHaveLength(77);
    expect(new Set(texts)).toEqual(new Set(START_LIST));
  });

  it("gives each field a kind and each enum a closed list", () => {
    for (const [name, spec] of ENTRIES)
      for (const [field, f] of Object.entries(spec.fields)) {
        expect(Object.hasOwn(FIELD_KINDS, f.kind), `${name}.${field}`).toBe(true);
        if (f.kind === "enum") expect(f.values?.length ?? 0, `${name}.${field}`).toBeGreaterThan(0);
      }
  });

  it("names a stamp field only in the three route rows of plan 12h", () => {
    // The observer writes the stamp first, so a field of a stamp name would be lost (plan 12h).
    // The rows of plan 12d (SSO and SCIM) hold none.
    const stamped = ENTRIES.flatMap(([name, spec]) =>
      Object.keys(spec.fields)
        .filter((f) => (STAMP_FIELDS as readonly string[]).includes(f))
        .map((f) => `${name}.${f}`),
    );
    expect(stamped.sort()).toEqual([
      "error.internal.route",
      "operator.guard_refused.route",
      "operator.route_unauthorized.route",
    ]);
  });

  it("names no field that can hold a secret, a credential, or free text", () => {
    for (const [name, spec] of ENTRIES)
      for (const [field, f] of Object.entries(spec.fields)) {
        expect(FORBIDDEN, `${name}.${field}`).not.toContain(field);
        if (field === "code") expect(f.kind, `${name}.${field}`).toBe("code");
      }
  });

  it("validateEvent drops a bad field and names it, and keeps the event", () => {
    expect(validateEvent("social.token_status", { provider: "Google", status: 500 })).toEqual({
      fields: { status: 500 },
      rejected: ["provider"],
    });
  });

  it("validateEvent rejects a value outside the list of an enum field", () => {
    expect(validateEvent("hook.copy_failed", { hook: "x.y" })).toEqual({
      fields: {},
      rejected: ["hook"],
    });
  });

  it("validateEvent rejects an unknown field", () => {
    expect(validateEvent("social.token_status", { provider: "google", extra: 1 })).toEqual({
      fields: { provider: "google" },
      rejected: ["extra"],
    });
  });
});
