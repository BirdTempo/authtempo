import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { readBody } from "../src/http/body.js";
import { readJson, readOptionalJson } from "../src/http/json.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { readQuery } from "../src/http/routes/sso.js";
import { createAuth, createMemoryAdapter, createPbkdf2PasswordHash } from "../src/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { BASE_URL } from "./helpers.js";
import { oauthHandle, REDIRECT, tokenPost } from "./oauth-helpers.js";
import { scimAuth, scimToken } from "./scim/helpers.js";
import { GOOGLE } from "./social-helpers.js";
import { samlWorld } from "./sso/saml-helpers.js";
import { totpAuth, verifiedSession } from "./totp-helpers.js";

// A NUL or a lone surrogate in a JSON body answers invalid_body (plan 12g fix
// wave, m1). Before the fix, the storage port refused the where value, and
// the route answered 500 internal with an error line. adapter-sqlite holds the
// same test on node:sqlite (test/body-text.test.ts).

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";

afterEach(() => {
  vi.restoreAllMocks();
});

async function signedIn() {
  const mail: string[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m.text);
      },
    },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE] },
  });
  await auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail.at(-1) ?? "")?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  const cookie = `__Host-tempo_session=${r.value.token}`;
  const rename = (text: string) =>
    auth.handle(
      new Request(`${BASE}/auth/passkeys/rename`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN, cookie },
        body: text,
      }),
    );
  return { rename };
}

/** Each body text holds its fault as a JSON escape, as a client sends it. */
const REFUSED: [string, string][] = [
  ["a lone high surrogate in the id", '{"id":"\\ud800","name":"Phone"}'],
  ["a lone low surrogate in the id", '{"id":"\\udc00","name":"Phone"}'],
  ["a NUL in the id", '{"id":"a\\u0000b","name":"Phone"}'],
];

/**
 * Faults that the schema of a route would refuse too. The reader refuses
 * them under a schema that takes any value, so the walk itself is proven.
 */
const DEEP: [string, string][] = [
  ["a lone surrogate in a key", '{"\\ud800":1}'],
  ["a NUL in a key", '{"a\\u0000":1}'],
  ["a lone surrogate deep in a value", '{"extra":[{"a":["ok","\\udfff"]}]}'],
  ["a NUL in a top-level string", '"\\u0000"'],
];

const body = (text: string) =>
  new Request(`${BASE}/x`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: text,
  });

describe("readOptionalJson walks the whole body (plan 12i)", () => {
  // The passkey options, the impersonation stop, and the rewrap read an
  // optional body through it, so it holds the rule of readJson.
  it.each([...REFUSED, ...DEEP])("refuses %s as invalid_body", async (_, text) => {
    expect(await readOptionalJson(body(text), z.unknown())).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
  });

  it("reads an empty body as {} and a surrogate pair as text", async () => {
    expect(await readOptionalJson(body(""), z.unknown())).toEqual({ ok: true, value: {} });
    expect(await readOptionalJson(body('{"a":"\\ud83d\\ude00"}'), z.unknown())).toEqual({
      ok: true,
      value: { a: "\u{1F600}" },
    });
  });
});

describe("readJson walks the whole body", () => {
  it.each(DEEP)("refuses %s as invalid_body", async (_, text) => {
    expect(await readJson(body(text), z.unknown())).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
  });

  it("reads a surrogate pair and a plain body", async () => {
    const r = await readJson(body('{"a":["\\ud83d\\ude00",{"b":"c"}]}'), z.unknown());
    expect(r).toEqual({ ok: true, value: { a: ["\u{1F600}", { b: "c" }] } });
  });
});

describe("the JSON body reader refuses a NUL and a lone surrogate on memory", () => {
  it.each(REFUSED)("answers 400 invalid_body for %s", async (_, text) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rename } = await signedIn();
    const res = await rename(text);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(errors).not.toHaveBeenCalled();
  });

  it("reads a surrogate pair as text, so the rename answers not_found", async () => {
    const { rename } = await signedIn();
    const res = await rename('{"id":"\\ud83d\\ude00","name":"Phone"}');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

/** A form body, encoded as a browser encodes it. A form cannot carry a lone surrogate. */
const form = (pairs: [string, string][], path = "/x", headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(pairs).toString(),
  });

describe("readBody refuses a NUL in a form body (the 12g fix wave)", () => {
  it.each([
    ["a NUL in a value", [["next", "/inbox\u0000"]]],
    ["a NUL in a key", [["next\u0000", "/inbox"]]],
  ] as [string, [string, string][]][])("refuses %s as invalid_body", async (_, pairs) => {
    expect(await readBody(form(pairs), z.unknown())).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
  });

  it("answers a social link form with a NUL in next as invalid_body", async () => {
    const auth = totpAuth({ social: { google: GOOGLE, fetch: async () => new Response(null) } });
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const { token } = await verifiedSession(auth);
    const res = await handle(
      form([["next", "/inbox\u0000"]], "/auth/social/google/link", {
        origin: APP_ORIGIN,
        cookie: `${auth.config.cookieName}=${token}`,
      }),
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("auth_error")).toBe(
      "invalid_body",
    );
  });
});

describe("the OAuth body readers refuse a NUL and a lone surrogate (the 12g fix wave)", () => {
  it("answers a register body with a lone surrogate as invalid_client_metadata", async () => {
    const h = oauthHandle();
    const res = await h.auth.handle(
      new Request(`${BASE}/auth/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body: `{"redirect_uris":["${REDIRECT}"],"client_name":"\\ud800"}`,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_client_metadata" });
    expect(await h.storage.findMany("oauthClient", [])).toEqual([]);
  });

  it("answers a token form with a NUL as invalid_request", async () => {
    // Without the check the form reaches the grant switch: unsupported_grant_type.
    const res = await oauthHandle().auth.handle(tokenPost({ grant_type: "refresh_token\u0000" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });
});

describe("the operator rewrap reader refuses a NUL and a lone surrogate (ruling 26)", () => {
  const SECRET = "operator-secret-0123456789abcdef-0123456789";

  it.each([
    ["a NUL in the cursor", '{"after":"totp:a\\u0000"}'],
    ["a lone surrogate in the cursor", '{"after":"totp:\\ud800"}'],
  ])("answers 400 invalid_body for %s", async (_, text) => {
    // Two versions, so the rewrap reads the rows after the cursor. Without
    // the check the storage port refuses the where value: 500 internal.
    const auth = createAuth({
      baseURL: BASE,
      trustedOrigins: [APP_ORIGIN],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      secrets: [
        { version: 2, value: "q8JxVd3m0Yv2sZ7rKpT4wN1hLc9eFgAuBiOjQyRtSxM" },
        { version: 1, value: "0123456789abcdef0123456789abcdef" },
      ],
      operator: {
        secrets: [{ name: "keys", secretHash: await sha256Hex(SECRET), scopes: ["secrets"] }],
      },
    });
    const res = await auth.handle(
      new Request(`${BASE}/auth/operator/secrets/rewrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: APP_ORIGIN,
          authorization: `Operator ${SECRET}`,
        },
        body: text,
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });
});

describe("the 12d readers refuse a NUL and a lone surrogate (move onto main)", () => {
  it("answers a SCIM body with a NUL in a key or a value as invalidValue", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w);
    const user = (extra: string) =>
      `{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"ada@acme.example"${extra}}`;
    for (const extra of [',"displayName":"A\\u0000da"', ',"x\\u0000":1', ',"nickName":"\\ud800"']) {
      const res = await w.handle(
        new Request(`${BASE_URL}/auth/scim/v2/Users`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
          body: user(extra),
        }),
      );
      expect([res.status, await res.json()], extra).toEqual([
        400,
        {
          schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
          status: "400",
          scimType: "invalidValue",
          detail: "the body holds a NUL or a lone surrogate",
        },
      ]);
    }
  });

  it("reads an ACS form with a NUL as an empty form", async () => {
    const w = samlWorld();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await w.handle(
      new Request(`${BASE_URL}/auth/sso/c1/acs`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "SAMLResponse=PHg%2B&RelayState=a%00b",
      }),
    );
    expect(res.headers.get("location")).toContain("auth_error=sso_failed");
    // The form step, not the request step: the reader gave an empty form.
    expect(log.mock.calls).toEqual([["authtempo: sso failed", "c1", "form"]]);
  });

  it("answers a query with a NUL as invalid_body", () => {
    const schema = z.strictObject({ q: z.string() });
    expect(readQuery(new URL("https://x.example/?q=a%00b"), schema)).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(readQuery(new URL("https://x.example/?q=ab"), schema)).toEqual({
      ok: true,
      value: { q: "ab" },
    });
  });
});
