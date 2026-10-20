import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { createAuth, crossSiteRefusal } from "../src/create-auth.js";
import { json } from "../src/http/json.js";
import { createRouter, type Route } from "../src/http/router.js";
import { createMemoryAdapter } from "../src/storage/memory.js";

const BASE = "https://api.example.com";
const EVIL = "https://evil.example";
const input = {
  baseURL: BASE,
  secret: "0123456789abcdef0123456789abcdef",
  trustedOrigins: ["https://app.example.com"],
  storage: createMemoryAdapter(),
  mail: { send: async () => {} },
};
const config = resolveConfig(input);

/** A route that answers its method, its path, and its parameters. */
function echo(method: Route["method"], path: string, extra: Partial<Route> = {}): Route {
  return {
    method,
    path,
    ...extra,
    handler: async (ctx) => json({ method, path, params: ctx.params }),
  };
}

function send(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

describe("router parameter form (plan 12d)", () => {
  it("matches one segment and gives it to the handler", async () => {
    const handle = createRouter(config, [echo("GET", "/x/:id/y"), echo("GET", "/plain")]);
    const res = await handle(send("/auth/x/abc_1/y"));
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 200,
      body: { method: "GET", path: "/x/:id/y", params: { id: "abc_1" } },
    });
    // A SCIM schema id is a URN, so the set holds the colon and the dot.
    const urn = await handle(send("/auth/x/urn:ietf:params:scim:schemas:core:2.0:User/y"));
    expect(await urn.json()).toMatchObject({
      params: { id: "urn:ietf:params:scim:schemas:core:2.0:User" },
    });
    // An exact route gets an empty object.
    expect(await (await handle(send("/auth/plain"))).json()).toMatchObject({ params: {} });
  });

  it("refuses a segment outside the set", async () => {
    let calls = 0;
    const route = echo("GET", "/x/:id/y");
    const handle = createRouter(config, [
      {
        ...route,
        handler: async (ctx) => {
          calls++;
          return route.handler(ctx);
        },
      },
    ]);
    const paths = [
      "/auth/x/a%2Fb/y",
      "/auth/x//y",
      `/auth/x/${"a".repeat(129)}/y`,
      "/auth/x/a%20b/y",
      "/auth/x/%61/y",
      // The URL parser removes a dot segment, so none reaches the matcher.
      "/auth/x/%2e%2e/y",
      "/auth/x/./y",
      "/auth/x/abc",
      "/auth/x/abc/y/z",
    ];
    const statuses = await Promise.all(paths.map(async (p) => (await handle(send(p))).status));
    expect({ statuses, calls }).toEqual({ statuses: paths.map(() => 404), calls: 0 });
    expect((await handle(send(`/auth/x/${"a".repeat(128)}/y`))).status).toBe(200);
  });

  it("lets an exact route win", async () => {
    const handle = createRouter(config, [echo("GET", "/x/:id"), echo("GET", "/x/discover")]);
    expect(await (await handle(send("/auth/x/discover"))).json()).toEqual({
      method: "GET",
      path: "/x/discover",
      params: {},
    });
    expect(await (await handle(send("/auth/x/other"))).json()).toMatchObject({
      path: "/x/:id",
      params: { id: "other" },
    });
  });

  it("refuses two routes of one shape at construction", () => {
    expect(() => createRouter(config, [echo("GET", "/x/:a"), echo("GET", "/x/:b")])).toThrow(
      "two routes match GET /x/:b",
    );
    // Two shapes that one path can match: /x/b/y matches both.
    expect(() => createRouter(config, [echo("GET", "/x/:a/y"), echo("GET", "/x/b/:c")])).toThrow(
      "two routes match GET /x/b/:c",
    );
    expect(() => createRouter(config, [echo("POST", "/x"), echo("POST", "/x")])).toThrow(
      "two routes match POST /x",
    );
    // Another method, another literal, or another segment count is no clash.
    expect(() =>
      createRouter(config, [
        echo("GET", "/x/:a"),
        echo("PATCH", "/x/:a"),
        echo("GET", "/y/:a"),
        echo("GET", "/x/:a/z"),
      ]),
    ).not.toThrow();
  });

  it("serves PUT, PATCH, and DELETE", async () => {
    const handle = createRouter(config, [
      echo("PUT", "/items/:id"),
      echo("PATCH", "/items/:id"),
      echo("DELETE", "/items/:id"),
    ]);
    const answers = [];
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await handle(send("/auth/items/i1", { method, body: "{}" }));
      answers.push({ status: res.status, body: await res.json() });
    }
    expect(answers).toEqual(
      ["PUT", "PATCH", "DELETE"].map((method) => ({
        status: 200,
        body: { method, path: "/items/:id", params: { id: "i1" } },
      })),
    );
  });

  it("applies the Origin rule to the new methods", async () => {
    let calls = 0;
    const counted = (method: Route["method"], path: string): Route => ({
      method,
      path,
      handler: async () => {
        calls++;
        return json({ ok: true });
      },
    });
    const handle = createRouter(config, [
      counted("PUT", "/items/:id"),
      counted("PATCH", "/items/:id"),
      counted("DELETE", "/items/:id"),
      counted("PATCH", "/exact"),
    ]);
    const refused = [];
    for (const [method, path] of [
      ["PUT", "/auth/items/i1"],
      ["PATCH", "/auth/items/i1"],
      ["DELETE", "/auth/items/i1"],
      ["PATCH", "/auth/exact"],
    ] as const) {
      const res = await handle(send(path, { method, headers: { origin: EVIL }, body: "{}" }));
      refused.push({ method, path, status: res.status, body: await res.json() });
    }
    expect({ refused, calls }).toEqual({
      refused: refused.map(({ method, path }) => ({
        method,
        path,
        status: 403,
        body: { error: "origin_not_trusted" },
      })),
      calls: 0,
    });
    // A cross-site form PATCH with no Origin gets the Fetch Metadata rule.
    const form = await handle(
      send("/auth/items/i1", {
        method: "PATCH",
        headers: { "sec-fetch-site": "cross-site", "content-type": "text/plain" },
        body: "x",
      }),
    );
    expect({ status: form.status, calls }).toEqual({ status: 403, calls: 0 });
    // A server sends no Origin and no Sec-Fetch-Site, and a trusted Origin passes.
    const server = await handle(send("/auth/items/i1", { method: "PATCH", body: "{}" }));
    const trusted = await handle(
      send("/auth/items/i1", {
        method: "DELETE",
        headers: { origin: "https://app.example.com" },
      }),
    );
    expect({ server: server.status, trusted: trusted.status, calls }).toEqual({
      server: 200,
      trusted: 200,
      calls: 2,
    });
  });

  it("lets a parameter route skip the Origin rule with allowCrossSiteForm", async () => {
    const handle = createRouter(config, [
      echo("POST", "/form/:id/acs", { allowCrossSiteForm: true }),
      echo("POST", "/plain/:id/acs"),
    ]);
    const post = (path: string) =>
      handle(
        send(path, {
          method: "POST",
          headers: {
            origin: EVIL,
            "sec-fetch-site": "cross-site",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "SAMLResponse=x",
        }),
      );
    const allowed = await post("/auth/form/c1/acs");
    expect({ status: allowed.status, body: await allowed.json() }).toEqual({
      status: 200,
      body: { method: "POST", path: "/form/:id/acs", params: { id: "c1" } },
    });
    const plain = await post("/auth/plain/c1/acs");
    expect({ status: plain.status, body: await plain.json() }).toEqual({
      status: 403,
      body: { error: "origin_not_trusted" },
    });
  });

  it("refuses a foreign Origin on a PATCH through crossSiteRefusal", async () => {
    const auth = createAuth(input);
    const patch = crossSiteRefusal(
      auth,
      send("/auth/scim/v2/Users/u1", { method: "PATCH", headers: { origin: EVIL }, body: "{}" }),
    );
    expect({ status: patch?.status, body: await patch?.json() }).toEqual({
      status: 403,
      body: { error: "origin_not_trusted" },
    });
    for (const method of ["PUT", "DELETE"]) {
      const res = crossSiteRefusal(auth, send("/auth/x", { method, headers: { origin: EVIL } }));
      expect({ method, status: res?.status }).toEqual({ method, status: 403 });
    }
    // A GET keeps no Origin rule.
    expect(crossSiteRefusal(auth, send("/auth/x", { headers: { origin: EVIL } }))).toBeNull();
  });
});
