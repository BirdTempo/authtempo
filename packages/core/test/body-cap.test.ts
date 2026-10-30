import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAuth } from "../src/create-auth.js";
import { readBody } from "../src/http/body.js";
import { BodyTooLarge, REQUEST_BODY_MAX } from "../src/http/body-cap.js";
import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteContract } from "../src/http/contract/types.js";
import { readJson, readOptionalJson } from "../src/http/json.js";
import { createRouter } from "../src/http/router.js";
import { magicLinkRoutes } from "../src/http/routes/magic-link.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { newId } from "../src/primitives/ids.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";
import { oauthHandle } from "./oauth-helpers.js";

/**
 * The request body cap of core (ruling 43 of the 12j lane). The first test
 * computes the derivation that the comment of `REQUEST_BODY_MAX` states. The
 * other tests send a body over the cap, at the cap, with a false
 * `content-length`, and with none, to the readers and through the router.
 */

/** UTF-8 bytes of one UTF-16 unit of a JSON string: 3 for a character that is not a control character. */
const JSON_UNIT = 3;
/** Bytes of one UTF-16 unit of a form value: `%XX%XX%XX` for a character of 3 UTF-8 bytes. */
const FORM_UNIT = 9;
/** Digits, sign, point, and exponent of the longest JSON number that `JSON.stringify` writes. */
const NUMBER_MAX = 24;

interface ZodNode {
  readonly _zod: { readonly def: Record<string, unknown> & { type: string } };
}

/** The `max_length` or `length_equals` check of a string or an array, or null for none. */
function maxOf(def: ZodNode["_zod"]["def"]): number | null {
  let max: number | null = null;
  for (const check of (def.checks ?? []) as ZodNode[]) {
    const d = check._zod.def as { check?: string; maximum?: number; length?: number };
    if (d.check === "max_length" && d.maximum !== undefined)
      max = Math.min(max ?? d.maximum, d.maximum);
    if (d.check === "length_equals" && d.length !== undefined) max = d.length;
  }
  return max;
}

/**
 * The most bytes of a value of `node` as compact JSON, with `unit` bytes for
 * each UTF-16 unit of a string. A node that no schema bounds (a string or an
 * array with no max, a record, an unknown, an open object) adds its least
 * size and its path to `open`: the cap is its bound.
 */
function largest(node: ZodNode, path: string, unit: number, open: string[]): number {
  const def = node._zod.def;
  const inner = (key: string) => def[key] as ZodNode;
  switch (def.type) {
    case "object": {
      let n = 1;
      for (const [key, value] of Object.entries(def.shape as Record<string, ZodNode>))
        n += JSON.stringify(key).length + 1 + largest(value, `${path}.${key}`, unit, open) + 1;
      const rest = def.catchall as ZodNode | undefined;
      if (rest !== undefined && rest._zod.def.type !== "never") open.push(`${path}.*`);
      return n;
    }
    case "string": {
      const max = maxOf(def);
      if (max === null) open.push(path);
      return 2 + (max ?? 0) * unit;
    }
    case "array": {
      const max = maxOf(def);
      const element = largest(inner("element"), `${path}[]`, unit, open);
      if (max === null) open.push(`${path}[]`);
      return max === null ? 2 : 1 + max * (element + 1);
    }
    case "record":
      open.push(`${path}{}`);
      return 2;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
    case "nonoptional":
      return Math.max(
        largest(inner("innerType"), path, unit, open),
        def.type === "nullable" ? 4 : 0,
      );
    case "pipe":
      return largest(inner("in"), path, unit, open);
    case "union":
      return Math.max(...(def.options as ZodNode[]).map((o) => largest(o, path, unit, open)));
    case "enum":
      return Math.max(...Object.values(def.entries as object).map((v) => JSON.stringify(v).length));
    case "literal":
      return Math.max(...(def.values as unknown[]).map((v) => JSON.stringify(v).length));
    case "boolean":
      return 5;
    case "null":
      return 4;
    case "number":
    case "int":
      return NUMBER_MAX;
    default:
      open.push(`${path}: ${def.type}`);
      return 0;
  }
}

/** The largest valid body of each route with a body, largest first. */
function largestBodies(): { key: string; bytes: number }[] {
  const contract: Record<string, RouteContract> = ROUTE_CONTRACT;
  const rows: { key: string; bytes: number }[] = [];
  for (const [key, c] of Object.entries(contract)) {
    if (c.body === undefined) continue;
    const schema = c.body.schema as unknown as ZodNode;
    const json = c.body.media.includes("json") ? largest(schema, key, JSON_UNIT, []) : 0;
    // The JSON walk with the form unit: an upper bound of the form, which has no quotes or braces.
    const form = c.body.media.includes("form") ? largest(schema, key, FORM_UNIT, []) : 0;
    rows.push({ key, bytes: Math.max(json, form) });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the request body cap (ruling 43 of the 12j lane)", () => {
  it("derives REQUEST_BODY_MAX as the next power of two above the largest valid body of the contracts", () => {
    const rows = largestBodies();
    const top = rows[0];
    console.log(
      `body-cap: routes=${rows.length} largest=${top?.key} ${top?.bytes} cap=${REQUEST_BODY_MAX}`,
    );
    expect(top).toEqual({ key: "POST /sso/connections/update", bytes: 4_705_616 });
    expect(REQUEST_BODY_MAX).toBe(2 ** Math.ceil(Math.log2(top?.bytes ?? 0)));
    expect(top?.bytes ?? 0).toBeLessThan(REQUEST_BODY_MAX);
  });

  it("refuses a body one byte over the cap and parses nothing", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const { schema, parse: zod } = spySchema();
    const text = padded("{}", REQUEST_BODY_MAX + 1);
    await expect(readJson(jsonPost("/x", text), schema)).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(readOptionalJson(jsonPost("/x", text), schema)).rejects.toBeInstanceOf(
      BodyTooLarge,
    );
    await expect(readBody(jsonPost("/x", text), schema)).rejects.toBeInstanceOf(BodyTooLarge);
    const form = new Request(`${BASE_URL}/x`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: padded("a=b", REQUEST_BODY_MAX + 1),
    });
    await expect(readBody(form, schema)).rejects.toBeInstanceOf(BodyTooLarge);
    // The run parses small texts of its own; no parse took a body of this test.
    expect(parse.mock.calls.filter(([t]) => t.length > REQUEST_BODY_MAX)).toEqual([]);
    expect(zod).not.toHaveBeenCalled();
  });

  it("reads a body of exactly the cap", async () => {
    const text = padded(JSON.stringify({ a: "b" }), REQUEST_BODY_MAX);
    expect(new TextEncoder().encode(text).length).toBe(REQUEST_BODY_MAX);
    const schema = z.strictObject({ a: z.string() });
    expect(await readJson(jsonPost("/x", text), schema)).toEqual({ ok: true, value: { a: "b" } });
    expect(await readOptionalJson(jsonPost("/x", text), schema)).toEqual({
      ok: true,
      value: { a: "b" },
    });
  });

  it("refuses a body over the cap whose content-length is false", async () => {
    const { schema, parse } = spySchema();
    const text = padded("{}", REQUEST_BODY_MAX + 1);
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
      body: spaceStream(REQUEST_BODY_MAX + 1),
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    await expect(readJson(request, schema)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(parse).not.toHaveBeenCalled();
  });

  it("refuses a body over the cap of a request that the app cloned, and does not wait for the clone", async () => {
    const { schema } = spySchema();
    const request = jsonPost("/x", padded("{}", REQUEST_BODY_MAX + 1));
    // The clone is the other branch of a tee, and no one reads it.
    const kept = request.clone();
    await expect(readJson(request, schema)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(kept.bodyUsed).toBe(false);
  });

  it("answers 413 body_too_large through the router one byte over the cap, and 200 at the cap", async () => {
    const { config, mail } = makeAuth();
    const handle = createRouter(config, magicLinkRoutes(config));
    const body = JSON.stringify({ email: "ada@example.com" });
    const over = await handle(
      jsonPost("/auth/magic-link/request", padded(body, REQUEST_BODY_MAX + 1)),
    );
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "body_too_large" });
    expect(mail).toHaveLength(0);
    const at = await handle(jsonPost("/auth/magic-link/request", padded(body, REQUEST_BODY_MAX)));
    expect(at.status).toBe(200);
    expect(mail).toHaveLength(1);
    // A form post answers 413 too, not the redirect of a bad link.
    const form = await handle(
      new Request(`${BASE_URL}/auth/magic-link/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL },
        body: padded("token=x", REQUEST_BODY_MAX + 1),
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
        body: padded("grant_type=authorization_code", REQUEST_BODY_MAX + 1),
      }),
    );
    expect(token.status).toBe(413);
    expect(await token.json()).toEqual({ error: "body_too_large" });
    const register = await auth.handle(
      jsonPost("/auth/oauth/register", padded("{}", REQUEST_BODY_MAX + 1)),
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
    // 9.9 MB, the probe of the 12j fix report: past the cap, so neither JSON.parse nor zod sees it.
    expect(probe.length).toBeGreaterThan(9_900_000);
    const parse = vi.spyOn(JSON, "parse");
    const res = await auth.handle(
      jsonPost("/auth/organizations/invite", probe, {
        authorization: `Bearer ${session.value.token}`,
      }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "body_too_large" });
    expect(parse.mock.calls.filter(([text]) => text.length > REQUEST_BODY_MAX)).toEqual([]);
    expect(await storage.findMany("invitation", [])).toEqual([]);
  });
});
