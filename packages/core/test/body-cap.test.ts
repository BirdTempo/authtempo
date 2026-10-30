import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAuth } from "../src/create-auth.js";
import { CALLBACK_POST_LIMIT, START_LIMIT } from "../src/engine/social.js";
import { SCIM_ROLES_MAX } from "../src/engine/sso/connections.js";
import { SAML_FORM_MAX } from "../src/engine/sso/saml-sp.js";
import { readBody } from "../src/http/body.js";
import {
  BODY_BUSY_RETRY_SECONDS,
  BODY_CAP_FLOOR,
  BODY_CAPS,
  BODY_DEPTH_MAX,
  BODY_ITEMS_MAX,
  BodyBusy,
  BodyTooLarge,
  bodyCapOf,
  bodyClientOf,
  FORM_PAIRS_MAX,
  formPairsFit,
  ipBodyClient,
  jsonShapeFits,
  LARGE_READ_ANON_BUDGET,
  LARGE_READ_BUDGET,
  LARGE_READ_DEADLINE_FLOOR_MS,
  LARGE_READ_IDLE_MS,
  LARGE_READ_MIN_RATE,
  LARGE_READ_SHARE,
  LARGE_READ_USER_BUDGET,
  LARGE_READ_USER_MIN_RATE,
  LARGE_READS_PER_USER,
  largeReadCanStart,
  largeReadDeadlineMs,
  largeShareOf,
  REQUEST_BODY_MAX,
  readBodyText,
} from "../src/http/body-cap.js";
import { readJson, readOptionalJson } from "../src/http/json.js";
import type { RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { magicLinkRoutes } from "../src/http/routes/magic-link.js";
import { SSO_LARGE_READ_PER_USER, SSO_MANAGE_PER_USER } from "../src/http/routes/sso.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import type { AuthEvent } from "../src/observe/port.js";
import { newId } from "../src/primitives/ids.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { largestBodies } from "./body-limits.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";
import { oauthHandle } from "./oauth-helpers.js";
import { observed } from "./observe-helpers.js";
import { FAST } from "./password-helpers.js";
import { ssoAuth } from "./sso/helpers.js";
import { verifiedSession } from "./totp-helpers.js";

/**
 * The request body limits of core (rulings 43 and 46 of the 12j lane). The
 * first tests compute the derivation that the comments of `body-cap.ts`
 * state. The other tests send a body over the cap, at the cap, with a false
 * `content-length`, and with none, to the readers and through the router,
 * and a body past the depth and the item limits.
 */

/** The cap that the derivation gives a route: the next power of two above its largest body, at least the floor. */
const derivedCap = (bytes: number) =>
  Math.max(BODY_CAP_FLOOR, 2 ** Math.ceil(Math.log2(bytes + 1)));

/** A POST of `text` with a JSON type, with the length that the body has unless `length` says another. */
function jsonPost(path: string, text: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
    body: text,
  });
}

/** A body of `bytes` bytes: `json` and spaces after it. */
function padded(json: string, bytes: number): string {
  return json + " ".repeat(bytes - new TextEncoder().encode(json).length);
}

/** A stream of `bytes` spaces in chunks of 1 MiB, so the request has no `content-length`. */
function spaceStream(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1 << 20).fill(0x20);
  let left = bytes;
  return new ReadableStream({
    pull(controller) {
      if (left <= 0) return controller.close();
      const n = Math.min(left, chunk.byteLength);
      controller.enqueue(chunk.subarray(0, n));
      left -= n;
    },
  });
}

/** A schema whose parse is a spy, so a test sees that no parse ran. */
function spySchema() {
  const parse = vi.fn(() => ({ success: true as const, data: {} }));
  return { schema: { safeParse: parse } as unknown as z.ZodType<object>, parse };
}

/**
 * Puts a `URLSearchParams` in place that records the pairs of each text it
 * parses, so a test sees that no form past `FORM_PAIRS_MAX` reached it.
 */
function recordForms(): number[] {
  const pairs: number[] = [];
  const Real = URLSearchParams;
  vi.stubGlobal(
    "URLSearchParams",
    class extends Real {
      constructor(init?: ConstructorParameters<typeof Real>[0]) {
        if (typeof init === "string") pairs.push(init.split("&").length);
        super(init);
      }
    },
  );
  return pairs;
}

/** A form of `pairs` pairs: `a=b`, then a distinct empty key for each other pair. */
const formOf = (pairs: number) =>
  ["a=b", ...Array.from({ length: pairs - 1 }, (_, i) => `k${i}=`)].join("&");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Each node of a route body that no schema bounds, with the check that bounds
 * it (ruling 68 Low 1 of the 12j lane). The walk of body-limits.ts counts such
 * a node at its least size, so the largest valid body of its route is a lower
 * bound. A new open node fails the derivation test until it names its bound
 * here. The cap of the route and the shape scan bound every node; an entry
 * that names only them has no engine rule.
 */
const OPEN_NODES: Readonly<Record<string, string>> = {
  "POST /sso/connections/create.scimRoles{}": "SCIM_ROLES_MAX entries (engine/sso/connections.ts)",
  "POST /sso/connections/update.scimRoles{}": "SCIM_ROLES_MAX entries (engine/sso/connections.ts)",
  "POST /reauth.passkey.*":
    "the WebAuthn seam checks the fields that it reads; the cap of the route and the shape scan bound the rest",
  "POST /reauth.passkey.response.*":
    "the WebAuthn seam checks the fields that it reads; the cap of the route and the shape scan bound the rest",
  "POST /passkey/register/verify.response.*":
    "the WebAuthn seam checks the fields that it reads; the cap of the route and the shape scan bound the rest",
  "POST /passkey/register/verify.response.response.*":
    "the WebAuthn seam checks the fields that it reads; the cap of the route and the shape scan bound the rest",
  "POST /passkey/register/verify.name": "PASSKEY_NAME_MAX, 64 units (engine/passkeys.ts)",
  "POST /passkey/authenticate/verify.response.*":
    "the WebAuthn seam checks the fields that it reads; the cap of the route and the shape scan bound the rest",
  "POST /passkey/authenticate/verify.response.response.*":
    "the WebAuthn seam checks the fields that it reads; the cap of the route and the shape scan bound the rest",
  "POST /passkey/sign-up/verify.response.*":
    "the WebAuthn seam checks the fields that it reads; the cap of the route and the shape scan bound the rest",
  "POST /passkey/sign-up/verify.response.response.*":
    "the WebAuthn seam checks the fields that it reads; the cap of the route and the shape scan bound the rest",
  "POST /second-factor/passkey/enable.response: unknown":
    "the WebAuthn seam checks the fields that it reads; the cap of the route and the shape scan bound the rest",
  "POST /totp/verify.passkey: unknown":
    "the WebAuthn seam checks the fields that it reads; the cap of the route and the shape scan bound the rest",
  "POST /passkey/authenticate/options.extensions.prf.first":
    "the pattern of 43 base64url units of the PRF salt (contract/passkeys.ts)",
  "POST /passkey/authenticate/options.extensions.prf.second":
    "the pattern of 43 base64url units of the PRF salt (contract/passkeys.ts)",
  "POST /passkey/sign-up/options.name": "SIGN_UP_NAME_MAX, 80 units (engine/passkeys.ts)",
  "POST /passkeys/rename.name": "PASSKEY_NAME_MAX, 64 units (engine/passkeys.ts)",
  "POST /tokens.permissions{}":
    "statementFault (access.ts): each resource and action is a known name, at most 64 actions of 64 units",
  "POST /tokens/update.permissions{}":
    "statementFault (access.ts): each resource and action is a known name, at most 64 actions of 64 units",
  "POST /organizations/tokens.permissions{}":
    "statementFault (access.ts): each resource and action is a known name, at most 64 actions of 64 units",
  "POST /organizations/tokens/update.permissions{}":
    "statementFault (access.ts): each resource and action is a known name, at most 64 actions of 64 units",
  "POST /organizations/roles/create.permissions{}":
    "the refine of 64 resources (contract/roles.ts), then statementFault",
  "POST /organizations/roles/update.permissions{}":
    "the refine of 64 resources (contract/roles.ts), then statementFault",
  "POST /organizations/has-permission.permissions{}":
    "the refine of 64 resources (contract/organizations.ts)",
  "POST /tokens.metadata{}": "validMetadata, 4096 bytes as JSON (engine/tokens.ts)",
  "POST /organizations/tokens.metadata{}": "validMetadata, 4096 bytes as JSON (engine/tokens.ts)",
  "POST /organizations/create.metadata{}":
    "the refine of METADATA_MAX_BYTES, 4096 bytes as JSON (contract/organizations.ts)",
  "POST /organizations/update.metadata{}":
    "the refine of METADATA_MAX_BYTES, 4096 bytes as JSON (contract/organizations.ts)",
  "POST /tokens/update.expiresAt":
    "the cap of the route and the shape scan only: no engine rule bounds it; the ISO format takes any count of fraction digits",
  "POST /organizations/tokens/update.expiresAt":
    "the cap of the route and the shape scan only: no engine rule bounds it; the ISO format takes any count of fraction digits",
  "POST /oauth/register.redirect_uris[]":
    "redirectList: REDIRECT_MAX URIs of URI_MAX units (engine/oauth-clients.ts)",
  "POST /oauth/register.grant_types[]":
    "stringList: at most the served grants, each once (engine/oauth-clients.ts)",
  "POST /oauth/register.response_types[]":
    "subsetOf: each value is code; the cap of the route and the shape scan only: no engine rule bounds it for the count",
  "POST /oauth/register.jwks.keys[]{}":
    "clientKeySet: CLIENT_KEYS_MAX keys, each a key of one alg (engine/oauth-clients.ts)",
  "POST /oauth/register.jwks_uri": "validCimdUrl: URI_MAX units (engine/oauth-clients.ts)",
  "POST /oauth/register.post_logout_redirect_uris[]":
    "validRedirectUri: URI_MAX units, 10 URIs by the schema (engine/oauth-clients.ts)",
  "POST /oauth/register.backchannel_logout_uri":
    "validLogoutUri: URI_MAX units (engine/oauth-clients.ts)",
  "POST /oauth/register.id_token_signed_response_alg":
    "equal to the alg of jwtMint (engine/oauth-clients.ts)",
  "POST /operator/impersonate.reason": "operatorReason: REASON_MAX, 500 units (engine/operator)",
  "POST /operator/impersonate/stop.reason":
    "the cap of the route and the shape scan only: no engine rule bounds it; the audit row keeps the text",
  "POST /operator/secrets/rewrap.after":
    "the cap of the route and the shape scan only: no engine rule bounds it; CURSOR (engine/secrets.ts) checks the kind only",
};

describe("the request body cap (rulings 43 and 46 of the 12j lane)", () => {
  it("derives the cap of each route as the next power of two above its largest valid body, at least 64 KiB", () => {
    const rows = largestBodies();
    const table = rows.map((r) => ({ ...r, cap: bodyCapOf(r.key as RouteKey) }));
    const perCap = new Map<number, number>();
    for (const r of table) perCap.set(r.cap, (perCap.get(r.cap) ?? 0) + 1);
    console.log(
      `body-cap: routes=${rows.length} ${[...perCap]
        .sort(([a], [b]) => a - b)
        .map(([cap, n]) => `cap ${cap}: ${n}`)
        .join(", ")}`,
    );
    console.log(
      table
        .map(
          (r) =>
            `body-cap: ${r.key} largest=${r.bytes} depth=${r.depth} items=${r.items} pairs=${r.pairs} cap=${r.cap}`,
        )
        .join("\n"),
    );
    expect(rows[0]).toMatchObject({ key: "POST /sso/connections/update", bytes: 4_705_616 });
    // A route above its cap fails, and so does a cap that is not its derived value.
    expect(table.filter((r) => r.bytes >= r.cap)).toEqual([]);
    expect(table.filter((r) => r.cap !== derivedCap(r.bytes)).map((r) => r.key)).toEqual([]);
    // BODY_CAPS names only the routes above the floor, and each is a route with a body.
    for (const [key, cap] of Object.entries(BODY_CAPS)) {
      expect(cap).toBeGreaterThan(BODY_CAP_FLOOR);
      expect(rows.map((r) => r.key)).toContain(key);
    }
    expect(REQUEST_BODY_MAX).toBe(Math.max(...table.map((r) => r.cap)));
    expect(perCap).toEqual(
      new Map([
        [65_536, rows.length - 3],
        [262_144, 1],
        [8_388_608, 2],
      ]),
    );
  });

  it("holds every open node of every route to the check that bounds it (ruling 68 Low 1)", () => {
    const rows = largestBodies();
    const open = [...new Set(rows.flatMap((r) => r.open))].sort();
    console.log(
      `body-cap: open nodes=${open.length} of ${rows.filter((r) => r.open.length > 0).length} routes`,
    );
    expect(open).toEqual(Object.keys(OPEN_NODES).sort());
  });

  it("leaves 14 levels to the values of a metadata record at depth 2 of its body", () => {
    // `{"metadata":{"k":` is depth 2; each `[` of the value is one more level.
    const metadata = (levels: number) =>
      `{"metadata":{"k":${"[".repeat(levels)}${"]".repeat(levels)}}}`;
    expect(BODY_DEPTH_MAX - 2).toBe(14);
    expect(jsonShapeFits(metadata(14))).toBe(true);
    expect(jsonShapeFits(metadata(15))).toBe(false);
  });

  it("derives BODY_DEPTH_MAX as the deepest schema plus a margin of 12", () => {
    const rows = largestBodies();
    const deepest = Math.max(...rows.map((r) => r.depth));
    console.log(
      `body-cap: deepest=${deepest} at ${rows.filter((r) => r.depth === deepest).map((r) => r.key)} limit=${BODY_DEPTH_MAX}`,
    );
    expect(deepest).toBe(4);
    expect(BODY_DEPTH_MAX).toBe(deepest + 12);
  });

  it("derives BODY_ITEMS_MAX as 8 times the next power of two above the most items of a valid body", () => {
    const rows = largestBodies();
    const most = rows.reduce((a, b) => (b.items > a.items ? b : a));
    // scimRoles counts as one item in the schema walk; the engine takes at most SCIM_ROLES_MAX entries.
    const withRoles = most.items + (SCIM_ROLES_MAX - 1);
    console.log(
      `body-cap: most items ${most.key} ${most.items}, ${withRoles} with scimRoles, limit=${BODY_ITEMS_MAX}`,
    );
    expect(most).toMatchObject({ key: "POST /sso/connections/update", items: 230 });
    expect(most.open).toEqual(["POST /sso/connections/update.scimRoles{}"]);
    expect(BODY_ITEMS_MAX).toBe(8 * 2 ** Math.ceil(Math.log2(withRoles)));
  });

  it("derives FORM_PAIRS_MAX as 8 times the next power of two above the most fields of a form route", () => {
    const forms = largestBodies().filter((r) => r.media.includes("form"));
    const most = forms.reduce((a, b) => (b.pairs > a.pairs ? b : a));
    console.log(
      `body-cap: form routes=${forms.length}, most fields ${most.key} ${most.pairs}, limit=${FORM_PAIRS_MAX}`,
    );
    expect(forms.every((r) => r.pairs > 0)).toBe(true);
    expect(most).toMatchObject({ key: "POST /oauth/token", pairs: 12 });
    expect(FORM_PAIRS_MAX).toBe(8 * 2 ** Math.ceil(Math.log2(most.pairs)));
  });

  it("refuses a form of more than FORM_PAIRS_MAX pairs before URLSearchParams", async () => {
    const pairs = recordForms();
    const schema = z.object({ a: z.string() });
    const formPost = (body: string) =>
      new Request(`${BASE_URL}/x`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    expect(await readBody(formPost(formOf(FORM_PAIRS_MAX)), schema)).toEqual({
      ok: true,
      value: { a: "b" },
    });
    expect(await readBody(formPost(formOf(FORM_PAIRS_MAX + 1)), schema)).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
    // The probe of the re-review: keys with no "=", to the floor.
    const keys = "a&".repeat(BODY_CAP_FLOOR / 2);
    expect(await readBody(formPost(keys), schema)).toMatchObject({ code: "invalid_body" });
    expect(pairs).toEqual([FORM_PAIRS_MAX]);
    // An empty pair counts, as URLSearchParams splits it.
    expect(formPairsFit("&".repeat(FORM_PAIRS_MAX - 1))).toBe(true);
    expect(formPairsFit("&".repeat(FORM_PAIRS_MAX))).toBe(false);
  });

  it("answers invalid_request at the OAuth form routes for a form of more than FORM_PAIRS_MAX pairs", async () => {
    const { auth } = oauthHandle();
    const pairs = recordForms();
    for (const path of ["/auth/oauth/token", "/auth/oauth/revoke", "/auth/oauth/introspect"]) {
      const res = await auth.handle(
        new Request(`${BASE_URL}${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `grant_type=authorization_code&${formOf(FORM_PAIRS_MAX)}`,
        }),
      );
      expect([path, res.status, await res.json()]).toEqual([
        path,
        400,
        { error: "invalid_request" },
      ]);
    }
    expect(pairs.filter((n) => n > FORM_PAIRS_MAX)).toEqual([]);
  });

  it("checks that each field of an OAuth form and of the end-session query comes once, in one pass", async () => {
    const { auth } = oauthHandle();
    const getAll = vi.spyOn(URLSearchParams.prototype, "getAll");
    // FORM_PAIRS_MAX - 1 distinct keys: a getAll for each key took time of the keys squared.
    const keys = formOf(FORM_PAIRS_MAX - 1);
    const form = (body: string) =>
      auth.handle(
        new Request(`${BASE_URL}/auth/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      );
    // RFC 7009 section 2.2: an unknown token answers 200.
    expect((await form(`token=x&${keys}`)).status).toBe(200);
    const end = await auth.handle(new Request(`${BASE_URL}/auth/oauth/end-session?${keys}`));
    expect(end.status).toBe(200);
    expect(getAll.mock.calls.length).toBeLessThan(FORM_PAIRS_MAX / 4);
    // A repeated field still fails, at its first repeat.
    expect(await (await form(`token=x&${keys}&a=c`)).json()).toEqual({ error: "invalid_request" });
  });

  it("refuses a body one byte over the floor of a request with no route, and parses nothing", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const { schema, parse: zod } = spySchema();
    const text = padded("{}", BODY_CAP_FLOOR + 1);
    await expect(readJson(jsonPost("/x", text), schema)).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(readOptionalJson(jsonPost("/x", text), schema)).rejects.toBeInstanceOf(
      BodyTooLarge,
    );
    await expect(readBody(jsonPost("/x", text), schema)).rejects.toBeInstanceOf(BodyTooLarge);
    const form = new Request(`${BASE_URL}/x`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: padded("a=b", BODY_CAP_FLOOR + 1),
    });
    await expect(readBody(form, schema)).rejects.toBeInstanceOf(BodyTooLarge);
    // The run parses small texts of its own; no parse took a body of this test.
    expect(parse.mock.calls.filter(([t]) => t.length > BODY_CAP_FLOOR)).toEqual([]);
    expect(zod).not.toHaveBeenCalled();
  });

  it("reads a body of exactly the floor", async () => {
    const text = padded(JSON.stringify({ a: "b" }), BODY_CAP_FLOOR);
    expect(new TextEncoder().encode(text).length).toBe(BODY_CAP_FLOOR);
    const schema = z.strictObject({ a: z.string() });
    expect(await readJson(jsonPost("/x", text), schema)).toEqual({ ok: true, value: { a: "b" } });
    expect(await readOptionalJson(jsonPost("/x", text), schema)).toEqual({
      ok: true,
      value: { a: "b" },
    });
  });

  it("refuses a body over the cap whose content-length is false", async () => {
    const { schema, parse } = spySchema();
    const text = padded("{}", BODY_CAP_FLOOR + 1);
    const lying = jsonPost("/x", text, { "content-length": "2" });
    expect(lying.headers.get("content-length")).toBe("2");
    await expect(readJson(lying, schema)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(parse).not.toHaveBeenCalled();
  });

  it("refuses a streamed body over the cap that has no content-length", async () => {
    const { schema, parse } = spySchema();
    const request = new Request(`${BASE_URL}/x`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: spaceStream(BODY_CAP_FLOOR + 1),
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readJson(request, schema)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(parse).not.toHaveBeenCalled();
  });

  it("refuses a body over the cap of a request that the app cloned, and does not wait for the clone", async () => {
    const { schema } = spySchema();
    const request = jsonPost("/x", padded("{}", BODY_CAP_FLOOR + 1));
    // The clone is the other branch of a tee, and no one reads it.
    const kept = request.clone();
    await expect(readJson(request, schema)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(kept.bodyUsed).toBe(false);
  });

  it("answers 413 body_too_large through the router one byte over the cap of the route, and 200 at the cap", async () => {
    const { config, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    const body = JSON.stringify({ email: "ada@example.com" });
    const over = await handle(
      jsonPost("/auth/magic-link/request", padded(body, BODY_CAP_FLOOR + 1)),
    );
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "body_too_large" });
    expect(mail).toHaveLength(0);
    const at = await handle(jsonPost("/auth/magic-link/request", padded(body, BODY_CAP_FLOOR)));
    expect(at.status).toBe(200);
    expect(mail).toHaveLength(1);
    // A form post answers 413 too, not the redirect of a bad link.
    const form = await handle(
      new Request(`${BASE_URL}/auth/magic-link/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
        body: padded("token=x", BODY_CAP_FLOOR + 1),
      }),
    );
    expect(form.status).toBe(413);
    expect(await form.json()).toEqual({ error: "body_too_large" });
  });

  it("answers 413 body_too_large at the OAuth routes that read a body by hand", async () => {
    const { auth } = oauthHandle();
    const token = await auth.handle(
      new Request(`${BASE_URL}/auth/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: padded("grant_type=authorization_code", BODY_CAP_FLOOR + 1),
      }),
    );
    expect(token.status).toBe(413);
    expect(await token.json()).toEqual({ error: "body_too_large" });
    const register = await auth.handle(
      jsonPost("/auth/oauth/register", padded("{}", BODY_CAP_FLOOR + 1)),
    );
    expect(register.status).toBe(413);
    expect(await register.json()).toEqual({ error: "body_too_large" });
  });

  it("answers 413 to the 9.9 MB probe of teamIds at POST /organizations/invite and writes no row", async () => {
    const storage = createMemoryAdapter();
    const sent: string[] = [];
    const now = new Date("2026-01-01T00:00:00.000Z");
    const clock = { now: () => now };
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage,
      mail: { send: async (m) => void sent.push(m.text) },
      clock,
      limiter: createMemoryLimiter(clock),
      organizations: { teams: {} },
    });
    const ada = await storage.create("user", {
      id: newId(now),
      email: "ada@example.com",
      emailVerified: true,
      name: null,
      image: null,
      bannedAt: null,
      banReason: null,
      banUntil: null,
      username: null,
      displayUsername: null,
      phone: null,
      isAnonymous: false,
      createdAt: now,
      updatedAt: now,
    });
    const created = await auth.api.createOrganization({ user: ada, slug: "acme", name: "Acme" });
    if (!created.ok) throw new Error(created.code);
    await auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
    const link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(sent.at(-1) ?? "")?.[1] ?? "");
    const session = await auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null });
    if (!session.ok || !("token" in session.value)) throw new Error("no session");
    const probe = JSON.stringify({
      organizationId: created.value.organization.id,
      email: "dan@example.com",
      role: "member",
      teamIds: Array.from({ length: 1_000_000 }, (_, i) => `t${String(i).padStart(6, "0")}`),
    });
    // 9.9 MB, the probe of the 12j fix report: past the cap of the route, so neither JSON.parse nor zod sees it.
    expect(probe.length).toBeGreaterThan(9_900_000);
    const parse = vi.spyOn(JSON, "parse");
    const res = await auth.handle(
      jsonPost("/auth/organizations/invite", probe, {
        authorization: `Bearer ${session.value.token}`,
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body_too_large" });
    expect(parse.mock.calls.filter(([text]) => text.length > BODY_CAP_FLOOR)).toEqual([]);
    expect(await storage.findMany("invitation", [])).toEqual([]);
  });
  it("refuses a JSON body nested deeper than BODY_DEPTH_MAX before JSON.parse", async () => {
    const schema = z.unknown();
    const nest = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const parse = vi.spyOn(JSON, "parse");
    expect(await readJson(jsonPost("/x", nest(BODY_DEPTH_MAX)), schema)).toMatchObject({
      ok: true,
    });
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockClear();
    expect(await readJson(jsonPost("/x", nest(BODY_DEPTH_MAX + 1)), schema)).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
    expect(await readOptionalJson(jsonPost("/x", nest(BODY_DEPTH_MAX + 1)), schema)).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    expect(parse).not.toHaveBeenCalled();
    // A bracket or a brace inside a string is text, and an escaped quote does not end the string.
    expect(
      jsonShapeFits(JSON.stringify({ a: '[[[[[[[[[[[[[[[[[[[[{{{{{{{{{{{{{{{{{\\"[[[' })),
    ).toBe(true);
    expect(jsonShapeFits(`{"a":"\\\\"}${"[".repeat(BODY_DEPTH_MAX + 1)}`)).toBe(false);
  });

  it("refuses a JSON body with more than BODY_ITEMS_MAX items before JSON.parse", async () => {
    const schema = z.unknown();
    // A bracket and items - 1 commas: exactly `items` items.
    const flat = (items: number) => `[${"0,".repeat(items - 1)}0]`;
    const parse = vi.spyOn(JSON, "parse");
    expect(await readJson(jsonPost("/x", flat(BODY_ITEMS_MAX)), schema)).toMatchObject({
      ok: true,
    });
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockClear();
    expect(await readJson(jsonPost("/x", flat(BODY_ITEMS_MAX + 1)), schema)).toMatchObject({
      ok: false,
      code: "invalid_body",
    });
    // Empty arrays and objects count one item each, and a comma inside a string counts none.
    expect(jsonShapeFits(`[${"[],".repeat(BODY_ITEMS_MAX / 2)}0]`)).toBe(false);
    expect(jsonShapeFits(`[${"{},".repeat(BODY_ITEMS_MAX / 2 - 1)}0]`)).toBe(true);
    expect(jsonShapeFits(JSON.stringify([",".repeat(BODY_ITEMS_MAX * 2)]))).toBe(true);
    expect(parse).not.toHaveBeenCalled();
  });

  it("answers invalid_body at the OAuth register route for a body past the depth limit", async () => {
    const { auth } = oauthHandle();
    const deep = `{"redirect_uris":${"[".repeat(BODY_DEPTH_MAX)}${"]".repeat(BODY_DEPTH_MAX)}}`;
    const parse = vi.spyOn(JSON, "parse");
    const res = await auth.handle(jsonPost("/auth/oauth/register", deep));
    expect(res.status).toBe(400);
    expect(parse.mock.calls.filter(([t]) => t === deep)).toEqual([]);
  });
  it("answers invalid_body, not 500, for a body that a reader locked before the route", async () => {
    const schema = z.unknown();
    // An app took a reader and read nothing: bodyUsed is false, and the stream is locked.
    const locked = (request: Request) => {
      request.body?.getReader();
      expect([request.bodyUsed, request.body?.locked]).toEqual([false, true]);
      return request;
    };
    const fail = { ok: false, code: "invalid_body", status: 400 };
    expect(await readJson(locked(jsonPost("/x", "{}")), schema)).toEqual(fail);
    expect(await readOptionalJson(locked(jsonPost("/x", "{}")), schema)).toEqual(fail);
    const form = new Request(`${BASE_URL}/x`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=b",
    });
    expect(await readBody(locked(form), schema)).toEqual(fail);
    // The SCIM body reads through the same reader: its own 400.
    const { readScimBody } = await import("../src/http/routes/scim.js");
    const scim = await readScimBody(
      locked(
        new Request(`${BASE_URL}/auth/scim/v2/Users`, {
          method: "POST",
          headers: { "content-type": "application/scim+json" },
          body: "{}",
        }),
      ),
    );
    expect(scim.ok ? 200 : scim.response.status).toBe(400);
    // Through the router: the probe of the re-review answered 500 internal.
    const { config, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    const res = await handle(
      locked(jsonPost("/auth/magic-link/request", JSON.stringify({ email: "ada@example.com" }))),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(mail).toHaveLength(0);
  });

  it("answers invalid_body, not 500, for a body that was read before the route", async () => {
    const schema = z.unknown();
    const used = async (request: Request) => {
      await request.text();
      expect(request.bodyUsed).toBe(true);
      return request;
    };
    const fail = { ok: false, code: "invalid_body", status: 400 };
    expect(await readJson(await used(jsonPost("/x", "{}")), schema)).toEqual(fail);
    expect(await readOptionalJson(await used(jsonPost("/x", "{}")), schema)).toEqual(fail);
    const form = new Request(`${BASE_URL}/x`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=b",
    });
    expect(await readBody(await used(form), schema)).toEqual(fail);
    // Through the router: app middleware read the body first.
    const { config, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    const res = await handle(
      await used(
        jsonPost("/auth/magic-link/request", JSON.stringify({ email: "ada@example.com" })),
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(mail).toHaveLength(0);
  });
});

/**
 * A body of `bytes` spaces in chunks of 64 KiB that stops after `before`
 * bytes until `open` runs. `atGate` resolves when the reader asks for the
 * first chunk past `before`.
 */
function gatedBody(bytes: number, before: number) {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached = () => {};
  const atGate = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (sent >= bytes) return c.close();
      if (sent >= before) {
        reached();
        await gate;
      }
      const n = Math.min(65_536, (sent < before ? before : bytes) - sent);
      c.enqueue(new Uint8Array(n).fill(0x20));
      sent += n;
    },
  });
  return { stream, open, atGate };
}

/** A POST to `path` with a streamed body and no content-length. */
const streamPost = (path: string, body: ReadableStream<Uint8Array>, type = "application/json") =>
  new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": type, origin: BASE_URL },
    body,
    duplex: "half",
  } as RequestInit);

/** Lets each read in flight take the chunks that wait in its stream. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Reads that fill both halves of the budget and stop one chunk before their
 * end (ruling 66 Major 1 of the 12j lane): a user that holds
 * `LARGE_READ_USER_BUDGET`, and IPs that each hold `LARGE_READ_SHARE`,
 * which fill `LARGE_READ_ANON_BUDGET`. Each read is marked as handled, so a
 * failed check leaves no unhandled rejection; `sizes` gives the length of each.
 */
function fillHalves() {
  const layout = [
    { client: "user:hold", bytes: LARGE_READ_USER_BUDGET },
    ...Array.from({ length: LARGE_READ_ANON_BUDGET / LARGE_READ_SHARE }, (_, i) => ({
      client: `ip:hold-${i}`,
      bytes: LARGE_READ_SHARE,
    })),
  ].map((l) => ({ ...l, body: gatedBody(l.bytes, l.bytes - 65_536) }));
  const reads = layout.map((l) =>
    readBodyText(streamPost("/x", l.body.stream), REQUEST_BODY_MAX, l.client),
  );
  for (const r of reads) r.catch(() => {});
  return {
    reads,
    sizes: layout.map((l) => l.bytes),
    atGates: Promise.all(layout.map((l) => l.body.atGate)),
    open: () => {
      for (const l of layout) l.body.open();
    },
  };
}

/** The length that each read answers, or what it threw. */
const lengths = (reads: Promise<string | null>[]) =>
  Promise.all(
    reads.map((r) =>
      r.then(
        (t) => t?.length,
        (e: unknown) => e,
      ),
    ),
  );

describe("the budget of the large reads of an isolate (ruling 51 Minor 2 of the 12j lane)", () => {
  /** The reads of `fillHalves`, held at their gates. */
  async function holdBudget() {
    const fill = fillHalves();
    await fill.atGates;
    await settle();
    return fill;
  }

  it("derives LARGE_READ_BUDGET as 2 reads of REQUEST_BODY_MAX, in two halves of one read each", () => {
    expect(LARGE_READ_BUDGET).toBe(2 * REQUEST_BODY_MAX);
    // The halves add up to the budget, and neither lends to the other (ruling 66).
    expect(LARGE_READ_USER_BUDGET + LARGE_READ_ANON_BUDGET).toBe(LARGE_READ_BUDGET);
    expect([LARGE_READ_USER_BUDGET, LARGE_READ_ANON_BUDGET]).toEqual([
      REQUEST_BODY_MAX,
      REQUEST_BODY_MAX,
    ]);
    // The user half holds one SSO write of the largest valid body, and not two.
    const largest = largestBodies()[0]?.bytes ?? 0;
    expect(largest).toBeLessThanOrEqual(LARGE_READ_USER_BUDGET);
    expect(2 * largest).toBeGreaterThan(LARGE_READ_USER_BUDGET);
  });

  it("reads a full half of each kind at once, and answers BodyBusy to one more read of either half", {
    timeout: 30_000,
  }, async () => {
    const { reads, sizes, open } = await holdBudget();
    // One more read of a user, and one of another IP: each passes its half.
    for (const client of ["user:more", "ip:more"])
      await expect(
        readBodyText(
          streamPost("/x", gatedBody(1_000_000, 1_000_000).stream),
          REQUEST_BODY_MAX,
          client,
        ),
      ).rejects.toBeInstanceOf(BodyBusy);
    // A read at the floor takes no part in the budget.
    expect(
      await readBodyText(streamPost("/x", gatedBody(1000, 1000).stream), BODY_CAP_FLOOR),
    ).toHaveLength(1000);
    open();
    expect(await lengths(reads)).toEqual(sizes);
    // Each read freed its bytes at its end: both halves fill again.
    const again = fillHalves();
    again.open();
    expect(await lengths(again.reads)).toEqual(again.sizes);
  });

  it("answers 503 body_busy with Retry-After at the routes above the floor, and SCIM its own 503", {
    timeout: 30_000,
  }, async () => {
    const { reads, open } = await holdBudget();
    // The anonymous half holds 128 KiB more. The SAML ACS reads its form above the floor, with no sign-in.
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      organizations: {},
      sso: { saml: true, dns: [{ name: "a", txt: async () => [] }] },
    });
    const acs = await auth.handle(
      streamPost(
        "/auth/sso/01KDVDQ4K0M3BPSSWQAS1JPT17/acs",
        gatedBody(1_000_000, 1_000_000).stream,
        "application/x-www-form-urlencoded",
      ),
    );
    expect(acs.status).toBe(503);
    expect(acs.headers.get("retry-after")).toBe(String(BODY_BUSY_RETRY_SECONDS));
    expect(await acs.json()).toEqual({ error: "body_busy" });
    const { readScimBody } = await import("../src/http/routes/scim.js");
    const scim = await readScimBody(
      streamPost(
        "/auth/scim/v2/Users",
        gatedBody(1_000_000, 1_000_000).stream,
        "application/scim+json",
      ),
    );
    if (scim.ok) throw new Error("SCIM read the body");
    expect(scim.response.status).toBe(503);
    expect(scim.response.headers.get("retry-after")).toBe(String(BODY_BUSY_RETRY_SECONDS));
    // A route at the floor reads as before.
    const { config, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    const floor = await handle(
      jsonPost("/auth/magic-link/request", JSON.stringify({ email: "ada@example.com" })),
    );
    expect([floor.status, mail.length]).toEqual([200, 1]);
    open();
    await lengths(reads);
  });
});

/** A stream of `bytes` spaces: one chunk of `chunk` bytes after each wait of `everyMs` (a fake timer in a test). */
function trickleBody(bytes: number, chunk: number, everyMs: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (sent >= bytes) return c.close();
      await new Promise((resolve) => setTimeout(resolve, everyMs));
      const n = Math.min(chunk, bytes - sent);
      c.enqueue(new Uint8Array(n).fill(0x20));
      sent += n;
    },
  });
}

/** The end of `read`, or "open" while it runs: "ok", or the name of what it threw. */
function watch(read: Promise<unknown>) {
  let end = "open";
  read.then(
    () => {
      end = "ok";
    },
    (e: unknown) => {
      end = e instanceof Error ? e.name : String(e);
    },
  );
  return () => end;
}

describe("the deadlines of the large reads (ruling 59 Major 1 of the 12j lane)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives the deadline of each cap above the floor from LARGE_READ_MIN_RATE, at least 10 s", async () => {
    const { SCIM_BODY_MAX } = await import("../src/http/routes/scim.js");
    expect(LARGE_READ_IDLE_MS).toBe(10_000);
    expect(LARGE_READ_MIN_RATE).toBe(128 * 1024);
    expect(LARGE_READ_DEADLINE_FLOOR_MS).toBe(LARGE_READ_IDLE_MS);
    const caps = {
      "SSO write": REQUEST_BODY_MAX,
      "Apple callback": bodyCapOf("POST /social/apple/callback"),
      "SAML form": SAML_FORM_MAX,
      "SCIM body": SCIM_BODY_MAX,
    };
    const deadlines = Object.fromEntries(
      Object.entries(caps).map(([name, cap]) => [name, largeReadDeadlineMs(cap)]),
    );
    console.log(`body-cap: deadlines ${JSON.stringify(deadlines)}`);
    expect(deadlines).toEqual({
      "SSO write": 64_000,
      "Apple callback": 10_000,
      "SAML form": 10_000,
      "SCIM body": 10_000,
    });
    // The largest valid SSO write and a full SAML form each arrive in time at the least rate.
    const largest = largestBodies()[0]?.bytes ?? Number.POSITIVE_INFINITY;
    expect((largest * 1000) / LARGE_READ_MIN_RATE).toBeLessThan(deadlines["SSO write"] ?? 0);
    expect((SAML_FORM_MAX * 1000) / LARGE_READ_MIN_RATE).toBeLessThan(deadlines["SAML form"] ?? 0);
  });

  it("ends a stalled read above the floor at LARGE_READ_IDLE_MS with BodyTimeout, and frees the budget", {
    timeout: 30_000,
  }, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Reads that stall one chunk before their end hold both halves of the budget.
    const fill = fillHalves();
    // A body that sends no byte at all: its read ends at the idle limit, not at 64 s.
    const silent = gatedBody(REQUEST_BODY_MAX, 0);
    try {
      const ends = fill.reads.map(watch);
      const count = ends.length;
      await fill.atGates;
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        readBodyText(streamPost("/x", gatedBody(1_000_000, 1_000_000).stream), REQUEST_BODY_MAX),
      ).rejects.toBeInstanceOf(BodyBusy);
      const none = watch(readBodyText(streamPost("/x", silent.stream), REQUEST_BODY_MAX));
      await vi.advanceTimersByTimeAsync(LARGE_READ_IDLE_MS - 1);
      expect([...ends.map((end) => end()), none()]).toEqual(Array(count + 1).fill("open"));
      await vi.advanceTimersByTimeAsync(1);
      expect([...ends.map((end) => end()), none()]).toEqual(Array(count + 1).fill("BodyTimeout"));
      // The stalled reads freed their bytes: both halves fill again.
      const again = fillHalves();
      again.open();
      expect(await lengths(again.reads)).toEqual(again.sizes);
    } finally {
      // A failed check must not leave held reads behind for the next test.
      fill.open();
      silent.open();
    }
  });

  it("ends a read above the floor that trickles past the time of its cap, though no wait reaches the idle limit", {
    timeout: 30_000,
  }, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // 1 KiB each second: a chunk well within the idle limit, a rate far under LARGE_READ_MIN_RATE.
    const end = watch(
      readBodyText(streamPost("/x", trickleBody(REQUEST_BODY_MAX, 1024, 1000)), REQUEST_BODY_MAX),
    );
    const deadline = largeReadDeadlineMs(REQUEST_BODY_MAX);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(end()).toBe("open");
    await vi.advanceTimersByTimeAsync(1);
    expect(end()).toBe("BodyTimeout");
    // A read at the floor has no deadline: it waits for its client.
    const floor = watch(
      readBodyText(streamPost("/x", trickleBody(BODY_CAP_FLOOR, 1024, 20_000)), BODY_CAP_FLOOR),
    );
    await vi.advanceTimersByTimeAsync(20_000 * 4);
    expect(floor()).toBe("open");
    await vi.advanceTimersByTimeAsync(20_000 * 64);
    expect(floor()).toBe("ok");
  });

  it("answers 408 body_timeout through the router at the SAML ACS, with no sign-in", {
    timeout: 30_000,
  }, async () => {
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      organizations: {},
      sso: { saml: true, dns: [{ name: "a", txt: async () => [] }] },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalled = gatedBody(SAML_FORM_MAX, 1_048_576);
    let answered: Response | null = null;
    void auth
      .handle(
        streamPost(
          "/auth/sso/01KDVDQ4K0M3BPSSWQAS1JPT17/acs",
          stalled.stream,
          "application/x-www-form-urlencoded",
        ),
      )
      .then((res) => {
        answered = res;
      });
    await stalled.atGate;
    await vi.advanceTimersByTimeAsync(LARGE_READ_IDLE_MS - 1);
    expect(answered).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const res = answered as Response | null;
    expect(res?.status).toBe(408);
    expect(res?.headers.get("retry-after")).toBeNull();
    expect(await res?.json()).toEqual({ error: "body_timeout" });
    stalled.open();
  });
});

/** A POST to the SAML ACS of any connection id from `ip`, with no sign-in. */
const acsPost = (ip: string, body: ReadableStream<Uint8Array> | string) =>
  new Request(`${BASE_URL}/auth/sso/01KDVDQ4K0M3BPSSWQAS1JPT17/acs`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body,
    duplex: "half",
  } as RequestInit);

/** An engine with SAML on and no connection: the ACS reads the form of any post. */
const samlAuth = () =>
  createAuth({
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    organizations: {},
    sso: { saml: true, dns: [{ name: "a", txt: async () => [] }] },
  });

describe("the share of one client of the large reads (ruling 59 Major 1 of the 12j lane)", () => {
  it("derives LARGE_READ_SHARE as half of the anonymous half, and lets only a user hold a larger cap", async () => {
    expect(LARGE_READ_SHARE).toBe(LARGE_READ_BUDGET / 4);
    expect(LARGE_READ_SHARE).toBe(LARGE_READ_ANON_BUDGET / 2);
    expect(largeShareOf("ip:203.0.113.7", SAML_FORM_MAX)).toBe(LARGE_READ_SHARE);
    expect(Math.floor(LARGE_READ_SHARE / SAML_FORM_MAX)).toBe(3);
    // An IP keeps its share at any cap (ruling 66); a user may hold the cap of its read.
    expect(largeShareOf("ip:203.0.113.7", REQUEST_BODY_MAX)).toBe(LARGE_READ_SHARE);
    expect(largeShareOf("user:ada", REQUEST_BODY_MAX)).toBe(REQUEST_BODY_MAX);
    // The largest valid SSO write passes the share: a user still sends it whole, an IP does not.
    const largest = largestBodies()[0]?.bytes ?? 0;
    expect(largest).toBeGreaterThan(LARGE_READ_SHARE);
    expect(
      await readBodyText(streamPost("/x", spaceStream(largest)), REQUEST_BODY_MAX, "user:ada"),
    ).toHaveLength(largest);
    await expect(
      readBodyText(streamPost("/x", spaceStream(largest)), REQUEST_BODY_MAX, "ip:203.0.113.7"),
    ).rejects.toBeInstanceOf(BodyBusy);
  });

  it("holds at most the share of one IP for 16 stalled reads of it, and reads the body of another", {
    timeout: 30_000,
  }, async () => {
    // The probe of the re-review: 16 posts of 1 MiB of one SAML form each, which then stall.
    const stalls = Array.from({ length: 16 }, () => gatedBody(SAML_FORM_MAX, 1_048_576));
    const reads: Promise<unknown>[] = [];
    try {
      const ends: (() => string)[] = [];
      for (const g of stalls) {
        const read = readBodyText(streamPost("/x", g.stream), SAML_FORM_MAX, "ip:203.0.113.7");
        reads.push(read.catch(() => {}));
        ends.push(watch(read));
        // One read at a time: it reaches its stall, or it ends at once.
        await Promise.race([g.atGate, read.catch(() => {})]);
        await settle();
      }
      const states = ends.map((end) => end());
      expect(states.filter((x) => x === "open")).toHaveLength(LARGE_READ_SHARE / 1_048_576);
      expect(states.filter((x) => x === "BodyBusy")).toHaveLength(
        16 - LARGE_READ_SHARE / 1_048_576,
      );
      // Another client reads a whole form, and a read of the largest cap, at once.
      const form = gatedBody(SAML_FORM_MAX, SAML_FORM_MAX).stream;
      expect(
        await readBodyText(streamPost("/x", form), SAML_FORM_MAX, "ip:198.51.100.9"),
      ).toHaveLength(SAML_FORM_MAX);
      const large = gatedBody(REQUEST_BODY_MAX, REQUEST_BODY_MAX).stream;
      expect(
        await readBodyText(streamPost("/x", large), REQUEST_BODY_MAX, "user:bea"),
      ).toHaveLength(REQUEST_BODY_MAX);
    } finally {
      for (const g of stalls) g.open();
    }
    // The reads of the client ended and freed its share: it reads a whole form again.
    await Promise.all(reads);
    const again = gatedBody(SAML_FORM_MAX, SAML_FORM_MAX).stream;
    expect(
      await readBodyText(streamPost("/x", again), SAML_FORM_MAX, "ip:203.0.113.7"),
    ).toHaveLength(SAML_FORM_MAX);
  });

  it("keys a read before a session by its IP: the stalled ACS posts of one IP leave the ACS open to another", {
    timeout: 30_000,
  }, async () => {
    const auth = samlAuth();
    const stalls = Array.from({ length: 5 }, () => gatedBody(SAML_FORM_MAX, 1_048_576));
    const answers: (() => string)[] = [];
    try {
      for (const g of stalls) {
        let answer = "open";
        const res = auth.handle(acsPost("203.0.113.7", g.stream)).then(async (r) => {
          answer = `${r.status} ${r.status === 503 ? ((await r.json()) as { error: string }).error : ""}`;
        });
        answers.push(() => answer);
        await Promise.race([g.atGate, res]);
        await settle();
      }
      // Four posts of 1 MiB fill the share of the IP; the fifth answers 503 at once.
      expect(answers.map((a) => a())).toEqual(["open", "open", "open", "open", "503 body_busy"]);
      const other = await auth.handle(acsPost("198.51.100.9", "SAMLResponse=x&RelayState=y"));
      expect(other.status).toBe(302);
    } finally {
      for (const g of stalls) g.open();
    }
  });

  it("keys a read after a session by its user: one user from two IPs runs one large read", {
    timeout: 30_000,
  }, async () => {
    const w = ssoAuth({ sso: { saml: true }, password: { hash: FAST, uniformSignUp: false } });
    const ada = await verifiedSession(w, "ada@acme.example");
    const bea = await verifiedSession(w, "bea@acme.example");
    const write = (token: string, ip: string, body: ReadableStream<Uint8Array> | string) =>
      ssoWrite(w, token, ip, body);
    const first = gatedBody(REQUEST_BODY_MAX, 5 * 1_048_576);
    const second = gatedBody(REQUEST_BODY_MAX, 4 * 1_048_576);
    try {
      const held = write(ada.token, "203.0.113.1", first.stream);
      await first.atGate;
      // The same user from another IP: a second large read of the user, refused before any byte (ruling 69).
      const outcome = await Promise.race([
        write(ada.token, "203.0.113.2", second.stream).then((r) => r.status),
        second.atGate.then(() => "read past the share of the user"),
      ]);
      expect(outcome).toBe(503);
      // Another user from that IP: the read runs, and the schema refuses the body.
      expect((await write(bea.token, "203.0.113.2", "{}")).status).toBe(400);
      first.open();
      expect((await held).status).toBe(400);
    } finally {
      first.open();
      second.open();
    }
  });
});

/** An SSO connection write of the session `token` from `ip`, through the router of `w`. */
const ssoWrite = (
  w: ReturnType<typeof ssoAuth>,
  token: string,
  ip: string,
  body: ReadableStream<Uint8Array> | string,
) =>
  w.handle(
    new Request(`${BASE_URL}/auth/sso/connections/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE_URL,
        cookie: `__Host-tempo_session=${token}`,
        "cf-connecting-ip": ip,
      },
      body,
      duplex: "half",
    } as RequestInit),
  );

/** "held" when `read` reaches the gate of its body, else how it ended: "ok", or the name of what it threw. */
const heldOrEnd = (read: Promise<unknown>, atGate: Promise<void>) =>
  Promise.race([
    atGate.then(() => "held"),
    read.then(
      () => "ok",
      (e: unknown) => (e instanceof Error ? e.name : String(e)),
    ),
  ]);

/** The status of an answer, and the code of a 503: "503 body_busy". */
const statusOf = async (r: Response) =>
  r.status === 503 ? `503 ${((await r.json()) as { error: string }).error}` : `${r.status}`;

describe("the two halves of the budget (ruling 66 Major 1 of the 12j lane)", () => {
  it("leaves the ACS open while two users hold 5 MiB each: the second answers 503 at the user half", {
    timeout: 30_000,
  }, async () => {
    const w = ssoAuth({ sso: { saml: true }, password: { hash: FAST, uniformSignUp: false } });
    const ada = await verifiedSession(w, "ada@acme.example");
    const bea = await verifiedSession(w, "bea@acme.example");
    const first = gatedBody(REQUEST_BODY_MAX, 5 * 1_048_576);
    const second = gatedBody(REQUEST_BODY_MAX, 5 * 1_048_576);
    const anon = ["ip:198.51.100.10", "ip:198.51.100.11"].map((client) => ({
      client,
      body: gatedBody(LARGE_READ_SHARE, LARGE_READ_SHARE - 65_536),
    }));
    try {
      const held = ssoWrite(w, ada.token, "203.0.113.1", first.stream);
      await first.atGate;
      // A second user: the user half holds 8 MiB in all, so its read stops there.
      const late = await Promise.race([
        ssoWrite(w, bea.token, "203.0.113.2", second.stream).then(statusOf),
        second.atGate.then(() => "read past the user half"),
      ]);
      expect(late).toBe("503 body_busy");
      // A third IP posts a whole SAML form to the ACS: it reads, and the SAML check refuses it.
      const acs = await w.handle(
        acsPost("198.51.100.9", gatedBody(SAML_FORM_MAX, SAML_FORM_MAX).stream),
      );
      expect([
        acs.status,
        new URL(acs.headers.get("location") ?? "x:").searchParams.get("auth_error"),
      ]).toEqual([302, "sso_failed"]);
      // Beside the user, the anonymous half is whole: two IPs each hold their share.
      const states = await Promise.all(
        anon.map(({ client, body }) =>
          heldOrEnd(
            readBodyText(streamPost("/x", body.stream), REQUEST_BODY_MAX, client),
            body.atGate,
          ),
        ),
      );
      expect(states).toEqual(["held", "held"]);
      first.open();
      expect((await held).status).toBe(400);
    } finally {
      first.open();
      second.open();
      for (const a of anon) a.body.open();
    }
  });

  it("leaves an SSO write open while 2 of 4 IPs fill the anonymous half, and answers 503 to a fifth IP", {
    timeout: 30_000,
  }, async () => {
    const w = ssoAuth({ sso: { saml: true }, password: { hash: FAST, uniformSignUp: false } });
    const ada = await verifiedSession(w, "ada@acme.example");
    // Each of 4 IPs posts its share in stalled ACS forms of 1 MiB.
    const per = LARGE_READ_SHARE / 1_048_576;
    const stalls = ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"].flatMap((ip) =>
      Array.from({ length: per }, () => ({ ip, body: gatedBody(SAML_FORM_MAX, 1_048_576) })),
    );
    const ends: Promise<unknown>[] = [];
    try {
      const answers: (() => string)[] = [];
      for (const s of stalls) {
        let answer = "open";
        const res = w.handle(acsPost(s.ip, s.body.stream)).then(async (r) => {
          answer = await statusOf(r);
        });
        ends.push(res);
        answers.push(() => answer);
        await Promise.race([s.body.atGate, res]);
        await settle();
      }
      // Two IPs fill the anonymous half with their shares; the posts of the other two answer 503.
      expect(answers.map((a) => a())).toEqual([
        ...Array(2 * per).fill("open"),
        ...Array(2 * per).fill("503 body_busy"),
      ]);
      // A fifth IP gets 503 too: the residual limit that the limits page states, 2 keys of 4 MiB
      // fill the half of 8 MiB (ruling 69 corrects the 4 keys at 16 MiB of ruling 66).
      expect(await statusOf(await w.handle(acsPost("198.51.100.9", "SAMLResponse=x")))).toBe(
        "503 body_busy",
      );
      // A signed-in user, from an IP that stalls, writes the largest valid SSO body: it reads whole.
      const largest = largestBodies()[0]?.bytes ?? 0;
      const write = await ssoWrite(w, ada.token, "203.0.113.1", spaceStream(largest));
      expect(write.status).toBe(400);
    } finally {
      for (const s of stalls) s.body.open();
    }
    await Promise.all(ends);
  });
});

/** A POST to the SAML ACS of any connection id with no client IP, as on a host with no `clientIp`. */
const acsPostNoIp = (body: ReadableStream<Uint8Array> | string) =>
  new Request(`${BASE_URL}/auth/sso/01KDVDQ4K0M3BPSSWQAS1JPT17/acs`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    duplex: "half",
  } as RequestInit);

describe("a read with no client IP (rulings 66 Minor 1 and 69 of the 12j lane)", () => {
  it("keys a request with no client IP as ip:unknown, with the share of one IP", () => {
    expect(ipBodyClient(null)).toBe("ip:unknown");
    // Ruling 69: no header text gives the client with no IP, the text unknown included.
    expect([ipBodyClient(""), ipBodyClient("unknown"), ipBodyClient("not-an-ip")]).toEqual([
      "ip:text:",
      "ip:text:unknown",
      "ip:text:not-an-ip",
    ]);
    expect(ipBodyClient("2001:db8:1:2:3:4:5:6")).toBe("ip:2001:db8:1:2::/64");
    expect(bodyClientOf(new Request(`${BASE_URL}/x`))).toBe("ip:unknown");
    // Ruling 69: the share of one IP, not the whole anonymous half.
    expect(largeShareOf("ip:unknown", SAML_FORM_MAX)).toBe(LARGE_READ_SHARE);
    expect(largeShareOf("ip:unknown", REQUEST_BODY_MAX)).toBe(LARGE_READ_SHARE);
  });

  it("holds 8 stalled posts with no IP to the share of one IP, and leaves the ACS open to an IP key", {
    timeout: 30_000,
  }, async () => {
    const auth = samlAuth();
    const share = LARGE_READ_SHARE / 1_048_576;
    const stalls = Array.from({ length: 2 * share }, () => gatedBody(SAML_FORM_MAX, 1_048_576));
    const ends: Promise<unknown>[] = [];
    const answers: (() => string)[] = [];
    try {
      for (const g of stalls) {
        let answer = "open";
        const res = auth.handle(acsPostNoIp(g.stream)).then(async (r) => {
          answer = await statusOf(r);
        });
        ends.push(res);
        answers.push(() => answer);
        await Promise.race([g.atGate, res]);
        await settle();
      }
      // Before the fix, all 8 held and filled the anonymous half: every client got 503.
      expect(answers.map((a) => a())).toEqual([
        ...Array(share).fill("open"),
        ...Array(share).fill("503 body_busy"),
      ]);
      // A client with an IP key reads a whole form: the SAML check refuses it.
      const other = await auth.handle(
        acsPost("198.51.100.9", gatedBody(SAML_FORM_MAX, SAML_FORM_MAX).stream),
      );
      expect([
        other.status,
        new URL(other.headers.get("location") ?? "x:").searchParams.get("auth_error"),
      ]).toEqual([302, "sso_failed"]);
      // Every caller with no IP is the one client whose share is full.
      expect(await statusOf(await auth.handle(acsPostNoIp("SAMLResponse=x")))).toBe(
        "503 body_busy",
      );
    } finally {
      for (const g of stalls) g.open();
    }
    await Promise.all(ends);
  });
});

describe("a header text that is not an IP (ruling 68 Low 4 and ruling 69 of the 12j lane)", () => {
  it("gives the text unknown and a text that is not an IP each the share of one IP, apart from no IP", {
    timeout: 30_000,
  }, async () => {
    const auth = samlAuth();
    const share = LARGE_READ_SHARE / 1_048_576;
    for (const text of ["unknown", "not-an-ip"]) {
      const stalls = Array.from({ length: share + 1 }, () => gatedBody(SAML_FORM_MAX, 1_048_576));
      const ends: Promise<unknown>[] = [];
      const answers: (() => string)[] = [];
      try {
        for (const g of stalls) {
          let answer = "open";
          const res = auth.handle(acsPost(text, g.stream)).then(async (r) => {
            answer = await statusOf(r);
          });
          ends.push(res);
          answers.push(() => answer);
          await Promise.race([g.atGate, res]);
          await settle();
        }
        // The header text holds the share of one IP, 4 MiB, and no more.
        expect(
          answers.map((a) => a()),
          text,
        ).toEqual([...Array(share).fill("open"), "503 body_busy"]);
        // A caller with no IP is another client: it reads a whole form. Before the fix, the
        // text unknown held the share of every caller with no IP.
        const none = await auth.handle(acsPostNoIp(gatedBody(SAML_FORM_MAX, SAML_FORM_MAX).stream));
        expect(
          [
            none.status,
            new URL(none.headers.get("location") ?? "x:").searchParams.get("auth_error"),
          ],
          text,
        ).toEqual([302, "sso_failed"]);
      } finally {
        for (const g of stalls) g.open();
      }
      await Promise.all(ends);
    }
  });
});

/** A form body of `bytes` bytes in chunks of 64 KiB that counts the bytes a reader pulled. */
function countedForm(bytes: number) {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) return c.close();
      const n = Math.min(65_536, bytes - sent);
      c.enqueue(new Uint8Array(n).fill(0x61));
      sent += n;
    },
  });
  return { stream, pulled: () => sent };
}

describe("the ACS reads no byte before its limit and its SAML check (ruling 59 Major 1 of the 12j lane)", () => {
  /** The `auth_error` of a redirect of the ACS. */
  const errorOf = (res: Response) =>
    new URL(res.headers.get("location") ?? "x:").searchParams.get("auth_error");

  it("answers sso_not_configured with SAML off, and reads no byte of the form", async () => {
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      organizations: {},
      sso: { oidc: true, dns: [{ name: "a", txt: async () => [] }] },
    });
    const body = countedForm(1_048_576);
    const res = await auth.handle(acsPost("203.0.113.7", body.stream));
    expect([res.status, errorOf(res)]).toEqual([302, "sso_not_configured"]);
    // At most the chunks that a stream fills ahead of a reader: no read ran.
    expect(body.pulled()).toBeLessThanOrEqual(2 * 65_536);
  });

  it("answers rate_limited past the ACS limit of an IP, and reads no byte of the form", async () => {
    const auth = samlAuth();
    // The ACS limit is 60 posts of one IP in 15 minutes (Behavior 2 of plan 12d Task 8).
    for (let i = 0; i < 60; i++)
      expect(errorOf(await auth.handle(acsPost("203.0.113.7", "SAMLResponse=x")))).toBe(
        "sso_failed",
      );
    const body = countedForm(1_048_576);
    const res = await auth.handle(acsPost("203.0.113.7", body.stream));
    expect([res.status, errorOf(res)]).toEqual([302, "rate_limited"]);
    expect(body.pulled()).toBeLessThanOrEqual(2 * 65_536);
    // Another IP still reads its form.
    const other = countedForm(1_048_576);
    expect(errorOf(await auth.handle(acsPost("198.51.100.9", other.stream)))).toBe("sso_failed");
    expect(other.pulled()).toBe(1_048_576);
  });
});

describe("the Apple form post reads no byte past its IP limit (ruling 68 Minor 2 of the 12j lane)", () => {
  /** A form post of Apple's callback from `ip`, cross-site as Apple sends it. */
  const applePost = (ip: string, body: ReadableStream<Uint8Array> | string) =>
    new Request(`${BASE_URL}/auth/social/apple/callback`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://appleid.apple.com",
        "cf-connecting-ip": ip,
      },
      body,
      duplex: "half",
    } as RequestInit);
  /** The `auth_error` of a redirect of the callback. */
  const errorOf = (res: Response) =>
    new URL(res.headers.get("location") ?? "x:").searchParams.get("auth_error");

  it("derives the limit of the callback form posts from the limit of the social start", () => {
    // Each callback ends one flow that a start began.
    expect(CALLBACK_POST_LIMIT).toEqual(START_LIMIT);
  });

  it("answers rate_limited past the limit of an IP, reads no byte of the form, and names the family", async () => {
    const s = observed();
    for (let i = 0; i < CALLBACK_POST_LIMIT.max; i++)
      expect(errorOf(await s.auth.handle(applePost("203.0.113.7", "code=c&state=nope")))).not.toBe(
        "rate_limited",
      );
    const body = countedForm(bodyCapOf("POST /social/apple/callback"));
    const res = await s.auth.handle(applePost("203.0.113.7", body.stream));
    expect([res.status, errorOf(res)]).toEqual([302, "rate_limited"]);
    // At most the chunks that a stream fills ahead of a reader: no read ran.
    expect(body.pulled()).toBeLessThanOrEqual(2 * 65_536);
    const hits = (await s.events()).filter((e) => e.name === "limit.hit");
    expect(hits.map((e) => (e as { family?: string }).family)).toEqual(["social-callback:ip"]);
    // Another IP still reads its whole form, and a GET callback of the first IP counts no post.
    const other = countedForm(bodyCapOf("POST /social/apple/callback"));
    expect(errorOf(await s.auth.handle(applePost("198.51.100.9", other.stream)))).not.toBe(
      "rate_limited",
    );
    expect(other.pulled()).toBe(bodyCapOf("POST /social/apple/callback"));
    const get = await s.auth.handle(
      new Request(`${BASE_URL}/auth/social/google/callback?code=c&state=nope`, {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
    );
    expect([get.status, errorOf(get)]).toEqual([302, "invalid_token"]);
  });
});

/** A body stream of `count` strings of 64 KiB, as an app can build it: no chunk has a byteLength. */
function stringBody(count: number) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(c) {
      if (pulled >= count) return c.close();
      pulled += 1;
      c.enqueue("a".repeat(65_536));
    },
    cancel() {
      cancelled = true;
    },
  }) as unknown as ReadableStream<Uint8Array>;
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

describe("a body chunk that is not bytes (ruling 59 Low 1 of the 12j lane)", () => {
  it("answers invalid_body at the first chunk, cancels the stream, and counts none of it", async () => {
    // 4 MiB of strings at the floor: before the fix the read passed the cap of 64 KiB.
    const body = stringBody(64);
    expect(await readJson(streamPost("/x", body.stream), z.unknown())).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
    expect(body.cancelled()).toBe(true);
    expect(body.pulled()).toBeLessThanOrEqual(2);
    // The SAML ACS answers its refusal of a bad form, not 500.
    const acs = await samlAuth().handle(acsPost("203.0.113.7", stringBody(64).stream));
    expect([
      acs.status,
      new URL(acs.headers.get("location") ?? "x:").searchParams.get("auth_error"),
    ]).toEqual([302, "sso_failed"]);
  });

  it("leaves the count of the budget whole after a read of strings above the floor", {
    timeout: 30_000,
  }, async () => {
    // Before the fix, the strings turned the count into NaN, and no read met the budget again.
    // The answer is held to the end, so the check of the budget runs in any case.
    const strings = await readBodyText(
      streamPost("/x", stringBody(4).stream),
      REQUEST_BODY_MAX,
      "strings",
    ).then(
      (t) => t,
      (e: unknown) => e,
    );
    // The strings counted in the anonymous half, so a read of that half checks the count.
    const fill = fillHalves();
    try {
      await fill.atGates;
      await settle();
      await expect(
        readBodyText(
          streamPost("/x", gatedBody(1_000_000, 1_000_000).stream),
          REQUEST_BODY_MAX,
          "more",
        ),
      ).rejects.toBeInstanceOf(BodyBusy);
      fill.open();
      expect(await lengths(fill.reads)).toEqual(fill.sizes);
    } finally {
      fill.open();
    }
    expect(strings).toBeNull();
  });
});

/** The `vm` module of Node. A specifier in a constant keeps it out of the typecheck of core, which has no Node types. */
const VM_MODULE = "node:vm";

/** A body stream of `chunks`, of any kind, one chunk at each pull. */
function chunkBody(chunks: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(c) {
      const next = chunks.shift();
      if (next === undefined) c.close();
      else c.enqueue(next);
    },
  }) as unknown as ReadableStream<Uint8Array>;
}

describe("the kind of a body chunk, not its realm (ruling 66 Low 1 of the 12j lane)", () => {
  it("reads a Uint8Array of another realm and a Buffer, and refuses each other kind of chunk", async () => {
    const vm = (await import(/* @vite-ignore */ VM_MODULE)) as {
      runInNewContext(code: string): unknown;
    };
    const other = vm.runInNewContext("new Uint8Array([123, 125])") as Uint8Array;
    // `instanceof` refused this chunk before the fix.
    expect(other instanceof Uint8Array).toBe(false);
    expect(await readBodyText(streamPost("/x", chunkBody([other])), BODY_CAP_FLOOR)).toBe("{}");
    const { Buffer } = globalThis as unknown as { Buffer: { from(text: string): Uint8Array } };
    expect(
      await readBodyText(streamPost("/x", chunkBody([Buffer.from("{}")])), BODY_CAP_FLOOR),
    ).toBe("{}");
    // A view that claims the tag of a Uint8Array is still a DataView.
    const claims = new DataView(new ArrayBuffer(2));
    Object.defineProperty(claims, Symbol.toStringTag, { value: "Uint8Array" });
    expect(Object.prototype.toString.call(claims)).toBe("[object Uint8Array]");
    const refused = [
      "{}",
      new ArrayBuffer(2),
      new DataView(new ArrayBuffer(2)),
      claims,
      new Uint8ClampedArray(2),
      { byteLength: 2 },
    ];
    for (const chunk of refused)
      expect(await readBodyText(streamPost("/x", chunkBody([chunk])), BODY_CAP_FLOOR)).toBeNull();
  });

  it("names a bad chunk at the SCIM read, apart from a body read before", async () => {
    const { readScimBody } = await import("../src/http/routes/scim.js");
    const detailOf = async (read: Awaited<ReturnType<typeof readScimBody>>) => {
      if (read.ok) throw new Error("SCIM read the body");
      return [read.response.status, ((await read.response.json()) as { detail: string }).detail];
    };
    const bad = await readScimBody(
      streamPost("/auth/scim/v2/Users", stringBody(4).stream, "application/scim+json"),
    );
    expect(await detailOf(bad)).toEqual([400, "the body holds a chunk that is not bytes"]);
    const used = streamPost("/auth/scim/v2/Users", chunkBody([]), "application/scim+json");
    await used.text();
    expect(await detailOf(await readScimBody(used))).toEqual([400, "the body was read before"]);
  });
});

/** An engine of the SSO writes whose sink keeps each event, with the raw IP, so a test reads the events. */
function observedSso() {
  const batches: AuthEvent[][] = [];
  const w = ssoAuth({
    sso: { saml: true },
    password: { hash: FAST, uniformSignUp: false },
    observe: { sink: { write: (b) => void batches.push([...b]) }, include: { ip: "raw" } },
  });
  const events = async () => {
    await w.config.observe.flush();
    return batches.flat();
  };
  return { w, events };
}

/** The request events of the SSO connection create: the fields that show an operator the pattern. */
const writeEvents = (events: AuthEvent[]) =>
  events
    .filter((e) => e.name === "request" && e.route === "POST /sso/connections/create")
    .map((e) => ({ status: e.status, code: e.code, ip: e.ip }));

describe("the bounds of the large reads of one user (ruling 69 of the 12j lane)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives the rate of a user, one read at a time, and 6 reads per hour", () => {
    expect(LARGE_READ_USER_MIN_RATE).toBe(256 * 1024);
    // A write of the cap in 32 s, and the largest valid write in 18 s.
    expect(largeReadDeadlineMs(REQUEST_BODY_MAX, LARGE_READ_USER_MIN_RATE)).toBe(32_000);
    const largest = largestBodies()[0]?.bytes ?? Number.POSITIVE_INFINITY;
    expect(Math.ceil(largest / LARGE_READ_USER_MIN_RATE)).toBe(18);
    // A read before a session keeps its own rate and its own deadline.
    expect(largeReadDeadlineMs(REQUEST_BODY_MAX)).toBe(64_000);
    expect(largeReadDeadlineMs(SAML_FORM_MAX)).toBe(LARGE_READ_DEADLINE_FLOOR_MS);
    expect(LARGE_READS_PER_USER).toBe(1);
    expect(SSO_LARGE_READ_PER_USER).toEqual({ seconds: 3600, max: 6 });
    // So one account holds the user half at most 6 times 32 s, 192 s, each hour.
    expect(
      SSO_LARGE_READ_PER_USER.max * largeReadDeadlineMs(REQUEST_BODY_MAX, LARGE_READ_USER_MIN_RATE),
    ).toBe(192_000);
  });

  it("runs one large read of a user at a time: a second answers BodyBusy before any byte", {
    timeout: 30_000,
  }, async () => {
    const first = gatedBody(REQUEST_BODY_MAX, 65_536);
    const held = readBodyText(streamPost("/x", first.stream), REQUEST_BODY_MAX, "user:ada");
    held.catch(() => {});
    try {
      await first.atGate;
      const second = countedForm(1_048_576);
      await expect(
        readBodyText(streamPost("/x", second.stream), REQUEST_BODY_MAX, "user:ada"),
      ).rejects.toBeInstanceOf(BodyBusy);
      // At most the chunks that a stream fills ahead of a reader: no read ran.
      expect(second.pulled()).toBeLessThanOrEqual(2 * 65_536);
      // Another user reads at once, and the same user reads a body at the floor.
      expect(
        await readBodyText(streamPost("/x", spaceStream(131_072)), REQUEST_BODY_MAX, "user:bea"),
      ).toHaveLength(131_072);
      expect(
        await readBodyText(streamPost("/x", spaceStream(1000)), BODY_CAP_FLOOR, "user:ada"),
      ).toHaveLength(1000);
    } finally {
      first.open();
    }
    expect(await held).toHaveLength(REQUEST_BODY_MAX);
    // The read ended, so the user reads again.
    expect(
      await readBodyText(streamPost("/x", spaceStream(100_000)), REQUEST_BODY_MAX, "user:ada"),
    ).toHaveLength(100_000);
  });

  it("ends a read of a user at the time of its cap at LARGE_READ_USER_MIN_RATE", {
    timeout: 30_000,
  }, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // 192 KiB each second: under the rate of a user, so the read of the cap ends at 32 s, not at 64 s.
    const end = watch(
      readBodyText(
        streamPost("/x", trickleBody(REQUEST_BODY_MAX, 196_608, 1000)),
        REQUEST_BODY_MAX,
        "user:ada",
      ),
    );
    const deadline = largeReadDeadlineMs(REQUEST_BODY_MAX, LARGE_READ_USER_MIN_RATE);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(end()).toBe("open");
    await vi.advanceTimersByTimeAsync(1);
    expect(end()).toBe("BodyTimeout");
  });

  it("answers 503 body_busy to a second SSO write of one account before any byte, with the request event", {
    timeout: 30_000,
  }, async () => {
    const { w, events } = observedSso();
    const ada = await verifiedSession(w, "ada@acme.example");
    const bea = await verifiedSession(w, "bea@acme.example");
    const first = gatedBody(REQUEST_BODY_MAX, 1_048_576);
    try {
      const held = ssoWrite(w, ada.token, "203.0.113.1", first.stream);
      await first.atGate;
      // The same account from another IP: its second write gets no byte read.
      const second = countedForm(1_048_576);
      expect(await statusOf(await ssoWrite(w, ada.token, "203.0.113.2", second.stream))).toBe(
        "503 body_busy",
      );
      expect(second.pulled()).toBeLessThanOrEqual(2 * 65_536);
      // Another account writes at once: the read runs, and the schema refuses the body.
      expect((await ssoWrite(w, bea.token, "203.0.113.3", "{}")).status).toBe(400);
      first.open();
      expect((await held).status).toBe(400);
    } finally {
      first.open();
    }
    // The request event carries the code, the route, and the IP of the refusal.
    expect(writeEvents(await events())).toEqual([
      { status: 503, code: "body_busy", ip: "203.0.113.2" },
      { status: 400, code: "invalid_body", ip: "203.0.113.3" },
      { status: 400, code: "invalid_body", ip: "203.0.113.1" },
    ]);
  });

  it("answers 408 body_timeout to a stalled SSO write of a user, with the request event", {
    timeout: 30_000,
  }, async () => {
    const { w, events } = observedSso();
    const ada = await verifiedSession(w, "ada@acme.example");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalled = gatedBody(REQUEST_BODY_MAX, 1_048_576);
    let answered: Response | null = null;
    void ssoWrite(w, ada.token, "203.0.113.1", stalled.stream).then((res) => {
      answered = res;
    });
    try {
      // The session check runs WebCrypto, which no fake timer moves: wait for the read itself.
      await stalled.atGate;
      await vi.advanceTimersByTimeAsync(LARGE_READ_IDLE_MS - 1);
      expect(answered).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect((answered as Response | null)?.status).toBe(408);
    } finally {
      stalled.open();
    }
    expect(writeEvents(await events())).toEqual([
      { status: 408, code: "body_timeout", ip: "203.0.113.1" },
    ]);
  });

  it("answers rate_limited to the seventh large read of one user in an hour, before any byte", {
    timeout: 30_000,
  }, async () => {
    const { w, events } = observedSso();
    const ada = await verifiedSession(w, "ada@acme.example");
    const bea = await verifiedSession(w, "bea@acme.example");
    for (let i = 0; i < SSO_LARGE_READ_PER_USER.max; i++)
      expect((await ssoWrite(w, ada.token, "203.0.113.1", "{}")).status).toBe(400);
    const seventh = countedForm(1_048_576);
    const res = await ssoWrite(w, ada.token, "203.0.113.1", seventh.stream);
    expect([res.status, await res.json()]).toEqual([429, { error: "rate_limited" }]);
    expect(seventh.pulled()).toBeLessThanOrEqual(2 * 65_536);
    expect((await events()).filter((e) => e.name === "limit.hit").map((e) => e.family)).toEqual([
      "sso-large-read:user",
    ]);
    // The limit is the user's own: another account writes, and the user writes in the next hour.
    expect((await ssoWrite(w, bea.token, "203.0.113.1", "{}")).status).toBe(400);
    w.clock.advance(SSO_LARGE_READ_PER_USER.seconds * 1000);
    expect((await ssoWrite(w, ada.token, "203.0.113.1", "{}")).status).toBe(400);
  });
});

/** An SSO connection write of `token` from `ip` with a body of `bytes` bytes and its content-length. */
const sizedSsoWrite = (w: ReturnType<typeof ssoAuth>, token: string, ip: string, bytes: number) =>
  w.handle(
    new Request(`${BASE_URL}/auth/sso/connections/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(bytes),
        origin: BASE_URL,
        cookie: `__Host-tempo_session=${token}`,
        "cf-connecting-ip": ip,
      },
      body: padded("{}", bytes),
    }),
  );

describe("a large read that cannot start spends no count (ruling 72 Minor 1 of the 12j lane)", () => {
  it("knows before any byte whether a read can start: the one read of a user, its half, and its share", {
    timeout: 30_000,
  }, async () => {
    const first = gatedBody(REQUEST_BODY_MAX, REQUEST_BODY_MAX - 16);
    const held = readBodyText(streamPost("/x", first.stream), REQUEST_BODY_MAX, "user:ada");
    held.catch(() => {});
    try {
      await first.atGate;
      await settle();
      // The user runs a read: no second read of the user starts, whatever its size.
      expect(largeReadCanStart("user:ada", REQUEST_BODY_MAX, "2")).toBe(false);
      // The user half holds 16 bytes less than its bytes: a read of 16 starts, one of 17 does not.
      expect(largeReadCanStart("user:bea", REQUEST_BODY_MAX, "16")).toBe(true);
      expect(largeReadCanStart("user:bea", REQUEST_BODY_MAX, "17")).toBe(false);
      // A body with no length needs 1 byte. A length past the cap starts: it answers 413 at once.
      expect(largeReadCanStart("user:bea", REQUEST_BODY_MAX, null)).toBe(true);
      expect(largeReadCanStart("user:bea", REQUEST_BODY_MAX, String(REQUEST_BODY_MAX + 1))).toBe(
        true,
      );
      // The anonymous half is apart: an IP starts a read of its share, and not one byte more.
      expect(largeReadCanStart("ip:a", REQUEST_BODY_MAX, String(LARGE_READ_SHARE))).toBe(true);
      expect(largeReadCanStart("ip:a", REQUEST_BODY_MAX, String(LARGE_READ_SHARE + 1))).toBe(false);
    } finally {
      first.open();
    }
    expect(await held).toHaveLength(REQUEST_BODY_MAX);
    expect(largeReadCanStart("user:ada", REQUEST_BODY_MAX, "2")).toBe(true);
  });

  it("answers 503 to each retry of another admin while one account holds the user half, and counts none", {
    timeout: 30_000,
  }, async () => {
    const { w, events } = observedSso();
    const ada = await verifiedSession(w, "ada@acme.example");
    const bea = await verifiedSession(w, "bea@acme.example");
    // Ada holds the user half less 16 bytes, as the probe of rr-bodycap56 did.
    const first = gatedBody(REQUEST_BODY_MAX, REQUEST_BODY_MAX - 16);
    const tries = SSO_MANAGE_PER_USER.max + 1;
    try {
      const held = ssoWrite(w, ada.token, "203.0.113.1", first.stream);
      await first.atGate;
      await settle();
      // Bea sends a write of 4 KiB again and again: more than both limits of a user allow.
      const answers: string[] = [];
      for (let i = 0; i < tries; i++)
        answers.push(await statusOf(await sizedSsoWrite(w, bea.token, "203.0.113.2", 4096)));
      expect(answers).toEqual(Array(tries).fill("503 body_busy"));
      first.open();
      expect((await held).status).toBe(400);
    } finally {
      first.open();
    }
    // No refused try counted: Bea still has each large read of the hour, then the limit.
    for (let i = 0; i < SSO_LARGE_READ_PER_USER.max; i++)
      expect((await sizedSsoWrite(w, bea.token, "203.0.113.2", 4096)).status).toBe(400);
    expect((await sizedSsoWrite(w, bea.token, "203.0.113.2", 4096)).status).toBe(429);
    const all = await events();
    expect(all.filter((e) => e.name === "limit.hit").map((e) => e.family)).toEqual([
      "sso-large-read:user",
    ]);
    expect(
      writeEvents(all).filter((e) => e.ip === "203.0.113.2" && e.code === "body_busy"),
    ).toHaveLength(tries);
  });
});
