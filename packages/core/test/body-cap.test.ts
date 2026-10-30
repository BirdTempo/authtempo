import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAuth } from "../src/create-auth.js";
import { SCIM_ROLES_MAX } from "../src/engine/sso/connections.js";
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
  FORM_PAIRS_MAX,
  formPairsFit,
  jsonShapeFits,
  LARGE_READ_BUDGET,
  REQUEST_BODY_MAX,
  readBodyText,
} from "../src/http/body-cap.js";
import { readJson, readOptionalJson } from "../src/http/json.js";
import type { RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { magicLinkRoutes } from "../src/http/routes/magic-link.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { newId } from "../src/primitives/ids.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { largestBodies } from "./body-limits.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";
import { oauthHandle } from "./oauth-helpers.js";

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

describe("the budget of the large reads of an isolate (ruling 51 Minor 2 of the 12j lane)", () => {
  /** The count of reads of REQUEST_BODY_MAX that the budget holds at once. */
  const COUNT = LARGE_READ_BUDGET / REQUEST_BODY_MAX;

  /** COUNT reads of REQUEST_BODY_MAX that stop one chunk before their end, and their promises. */
  async function holdBudget() {
    const held = Array.from({ length: COUNT }, () =>
      gatedBody(REQUEST_BODY_MAX, REQUEST_BODY_MAX - 65_536),
    );
    const reads = held.map((h) =>
      readBodyText(streamPost("/x", h.stream), REQUEST_BODY_MAX).then(
        (t) => t?.length,
        (e: unknown) => e,
      ),
    );
    await Promise.all(held.map((h) => h.atGate));
    await settle();
    const open = () => {
      for (const h of held) h.open();
    };
    return { reads, open };
  }

  it("derives LARGE_READ_BUDGET as 2 reads of REQUEST_BODY_MAX", () => {
    expect(COUNT).toBe(2);
    expect(LARGE_READ_BUDGET).toBe(2 * REQUEST_BODY_MAX);
    // Three SSO writes of the largest valid body fit at once.
    const largest = largestBodies()[0]?.bytes ?? 0;
    expect(3 * largest).toBeLessThanOrEqual(LARGE_READ_BUDGET);
  });

  it("reads the budget's count of large bodies at once, and answers BodyBusy to one more", {
    timeout: 30_000,
  }, async () => {
    const { reads, open } = await holdBudget();
    // One more read above the floor: its first chunks pass the budget.
    const more = gatedBody(REQUEST_BODY_MAX, REQUEST_BODY_MAX);
    await expect(
      readBodyText(streamPost("/x", more.stream), REQUEST_BODY_MAX),
    ).rejects.toBeInstanceOf(BodyBusy);
    // A read at the floor takes no part in the budget.
    expect(
      await readBodyText(streamPost("/x", gatedBody(1000, 1000).stream), BODY_CAP_FLOOR),
    ).toHaveLength(1000);
    open();
    expect(await Promise.all(reads)).toEqual(Array(COUNT).fill(REQUEST_BODY_MAX));
    // Each read freed its bytes at its end: the budget's count reads again.
    const again = Array.from({ length: COUNT }, () =>
      gatedBody(REQUEST_BODY_MAX, REQUEST_BODY_MAX),
    );
    expect(
      await Promise.all(
        again.map((g) => readBodyText(streamPost("/x", g.stream), REQUEST_BODY_MAX)),
      ),
    ).toHaveLength(COUNT);
  });

  it("answers 503 body_busy with Retry-After at the routes above the floor, and SCIM its own 503", {
    timeout: 30_000,
  }, async () => {
    const { reads, open } = await holdBudget();
    // The budget holds 128 KiB more. The SAML ACS reads its form above the floor, before any check.
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
    await Promise.all(reads);
  });
});
