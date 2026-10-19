import { describe, expect, it } from "vitest";
import { createSession } from "../src/engine/sessions.js";
import { ROUTE_CONTRACT } from "../src/http/contract/index.js";
import type { RouteContract } from "../src/http/contract/types.js";
import { AUTH_ERROR_PARAM } from "../src/http/redirect.js";
import { ROUTES, type RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { newId } from "../src/primitives/ids.js";
import { BASE, everyFeature } from "./every-feature.js";

/**
 * The auth probe of plan 11g Task 5: every route of `ROUTES` against the
 * credential forms of its entry. The world has every feature on, so every
 * route exists. A POST carries `baseURL` as its Origin: the router trusts it,
 * and the consent route takes a form from that origin only.
 */

const CONTRACT: Record<string, RouteContract> = ROUTE_CONTRACT;

/**
 * The body of a POST whose route answers 400 for `{}` before its credential
 * check. A route with no row sends `{}`. The first test holds each row to
 * the route's body schema, so a row cannot drift from the contract.
 */
const PROBE_BODIES: { readonly [K in RouteKey]?: unknown } = {};

/** What a route answered: the status, and the code of a JSON error or of a redirect's error parameter. */
interface Answer {
  status: number;
  code: string | null;
}

async function answerOf(res: Response): Promise<Answer> {
  if (res.status === 302 || res.status === 303) {
    const location = new URL(res.headers.get("location") ?? "", BASE);
    const code = location.searchParams.get(AUTH_ERROR_PARAM) ?? location.searchParams.get("error");
    return { status: res.status, code };
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("application/json")) {
    const body = (await res.json()) as { error?: string };
    return { status: res.status, code: body.error ?? null };
  }
  return { status: res.status, code: null };
}

const keys = ROUTES.map((r) => `${r.method} ${r.path}` as RouteKey);
const entryOf = (key: RouteKey) => {
  const entry = ROUTES.find((r) => `${r.method} ${r.path}` === key);
  if (!entry) throw new Error(`no entry ${key}`);
  return entry;
};
/** The credential forms of the entry, as plain strings. */
const authOf = (key: RouteKey): readonly string[] => entryOf(key).auth;

/** The request of one route: the path with a real provider, the body by its media, the headers. */
function requestOf(key: RouteKey, headers: Record<string, string>): Request {
  const entry = entryOf(key);
  const url = `${BASE}/auth${entry.path.replace(":provider", "google")}`;
  if (entry.method === "GET") return new Request(url, { headers });
  const body = PROBE_BODIES[key] ?? {};
  const media = CONTRACT[key]?.body?.media ?? ["json"];
  if (media.includes("json"))
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      body: JSON.stringify(body),
    });
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body as Record<string, string>)) params.set(k, v);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE, ...headers },
    body: params.toString(),
  });
}

function world() {
  const config = everyFeature();
  const handle = createRouter(config, coreRoutes(config));
  async function session(email: string): Promise<string> {
    const now = config.clock.now();
    const user = await config.storage.create("user", {
      id: newId(now),
      email,
      emailVerified: true,
      name: null,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    const { token } = await createSession(config, { userId: user.id, ip: null, userAgent: null });
    return token;
  }
  const cookie = (token: string) => ({ cookie: `${config.cookieName}=${token}` });
  return { config, handle, session, cookie };
}

/** The answers of the routes in `keys` with the same headers, by key. */
async function probe(
  w: ReturnType<typeof world>,
  routes: RouteKey[],
  headers: Record<string, string>,
): Promise<Record<string, Answer>> {
  const results: Record<string, Answer> = {};
  for (const key of routes) results[key] = await answerOf(await w.handle(requestOf(key, headers)));
  return results;
}

describe("the auth probe (plan 11g)", () => {
  it("answers 401 to each route that needs a credential when none is sent", async () => {
    // Each probe body parses under its route's schema, so a body cannot drift from the contract.
    for (const [key, body] of Object.entries(PROBE_BODIES)) {
      const schema = CONTRACT[key]?.body?.schema;
      expect(schema, `${key} has a probe body and no body schema`).toBeDefined();
      expect(schema?.safeParse(body).success, `${key}: the probe body does not parse`).toBe(true);
    }
    const w = world();
    const needs = keys.filter((key) => !authOf(key).includes("none"));
    expect(needs.length).toBeGreaterThan(0);
    const expected: Record<string, Answer> = {};
    for (const key of needs) {
      const auth = authOf(key);
      // A page GET sends the browser to the sign-in page: a redirect with no error. A page
      // POST (the device page, plan 12e) answers 401, as the consent POST does.
      if (CONTRACT[key]?.answer.kind === "html" && key.startsWith("GET "))
        expected[key] = { status: 302, code: null };
      else if (auth.includes("accessToken")) expected[key] = { status: 401, code: "invalid_token" };
      else expected[key] = { status: 401, code: "unauthorized" };
    }
    expect(await probe(w, needs, {})).toEqual(expected);
  });

  it("a tk_ bearer reaches no route that takes a session only", async () => {
    const w = world();
    const cookie = w.cookie(await w.session("ada@example.com"));
    const minted = await w.handle(
      new Request(`${BASE}/auth/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...cookie },
        body: JSON.stringify({ name: "probe" }),
      }),
    );
    expect(minted.status).toBe(200);
    const { token } = (await minted.json()) as { token: string };
    expect(token.startsWith("tk_")).toBe(true);
    const sessionOnly = keys.filter((key) => {
      const auth = authOf(key);
      return auth.includes("session") && !auth.includes("none") && !auth.includes("apiToken");
    });
    expect(sessionOnly.length).toBeGreaterThan(0);
    const expected: Record<string, Answer> = {};
    for (const key of sessionOnly) expected[key] = { status: 401, code: "unauthorized" };
    expect(await probe(w, sessionOnly, { authorization: `Bearer ${token}` })).toEqual(expected);
  });

  it("answers 401 to a wrong credential of each form that a route takes", async () => {
    const w = world();
    const garbage = "B".repeat(43);
    /** One wrong credential per form, and a bearer that is no token at all for every form. */
    const wrong: Record<string, Record<string, string>> = {
      "wrong cookie": { cookie: `${w.config.cookieName}=ts_${garbage}` },
      "wrong ts_ bearer": { authorization: `Bearer ts_${garbage}` },
      "wrong tk_ bearer": { authorization: `Bearer tk_${garbage}` },
      "garbage JWT": { authorization: "Bearer not.a.jwt" },
      "garbage access token": { authorization: `Bearer ${garbage}` },
      "wrong operator secret": { authorization: `Operator ${garbage}` },
      "garbage bearer": { authorization: "Bearer nope" },
    };
    const formsOf: Record<string, string[]> = {
      session: ["wrong cookie", "wrong ts_ bearer"],
      apiToken: ["wrong tk_ bearer"],
      sessionJwt: ["garbage JWT"],
      accessToken: ["garbage access token"],
      operator: ["wrong operator secret"],
    };
    const needs = keys.filter((key) => !authOf(key).includes("none"));
    const results: Record<string, Answer> = {};
    const expected: Record<string, Answer> = {};
    for (const key of needs) {
      const auth = authOf(key);
      const labels = [...auth.flatMap((form) => formsOf[form] ?? []), "garbage bearer"];
      const code = auth.includes("accessToken") ? "invalid_token" : "unauthorized";
      for (const label of labels) {
        const headers = wrong[label];
        if (!headers) throw new Error(`no credential ${label}`);
        results[`${key} with a ${label}`] = await answerOf(await w.handle(requestOf(key, headers)));
        expected[`${key} with a ${label}`] = { status: 401, code };
      }
    }
    expect(Object.keys(results).length).toBeGreaterThan(needs.length);
    expect(results).toEqual(expected);
  });

  it("a session reaches no route that takes a tk_ bearer only", async () => {
    const w = world();
    const cookie = w.cookie(await w.session("bob@example.com"));
    const tokenOnly = keys.filter((key) => {
      const auth = authOf(key);
      return auth.length === 1 && auth[0] === "apiToken";
    });
    expect(tokenOnly.length).toBeGreaterThan(0);
    const expected: Record<string, Answer> = {};
    for (const key of tokenOnly) expected[key] = { status: 401, code: "unauthorized" };
    expect(await probe(w, tokenOnly, cookie)).toEqual(expected);
  });
});
