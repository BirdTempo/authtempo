import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BODY_CAPS, bindBodyRoute } from "../../src/http/body-cap.js";
import { ROUTE_CONTRACT } from "../../src/http/contract/index.js";
import type { RouteContract } from "../../src/http/contract/types.js";
import { json } from "../../src/http/json.js";
import { ROUTES, type RouteKey } from "../../src/http/route-list.js";
import type { RouteContext } from "../../src/http/router.js";
import { managedBody, managedCall } from "../../src/http/routes/sso.js";
import { ok } from "../../src/result.js";
import { BASE_URL } from "../helpers.js";
import { ssoAuth } from "./helpers.js";

const CONTRACT: Record<string, RouteContract> = ROUTE_CONTRACT;

/** True when the route takes a session: the cookie or a bearer, or the cookie only. */
function takesSession(key: RouteKey): boolean {
  const entry = ROUTES.find((r) => `${r.method} ${r.path}` === key);
  if (!entry) throw new Error(`no route ${key}`);
  return entry.auth.some((form) => form === "session" || form === "sessionCookie");
}

describe("a session route with a cap above the floor names its row before the read (plan 12l)", () => {
  it("has a query schema in its contract for each such route", () => {
    const large = Object.keys(BODY_CAPS) as RouteKey[];
    expect(large.length).toBeGreaterThan(0);
    const session = large.filter(takesSession);
    for (const key of session) expect(CONTRACT[key]?.query, key).toBeDefined();
    // The two SSO connection writes are the session routes above the floor today.
    expect(session).toEqual(["POST /sso/connections/create", "POST /sso/connections/update"]);
  });

  it("refuses the floor form of the manager steps at a route above the floor, before the session read", async () => {
    const w = ssoAuth({ sso: { oidc: true } });
    // The context of a POST with no session, bound to the route `key` as the router binds each request.
    const contextOf = (key: RouteKey, path: string): RouteContext => {
      const request = new Request(`${BASE_URL}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: "{}",
      });
      bindBodyRoute(request, key);
      return {
        request,
        url: new URL(request.url),
        config: w.config,
        ip: null,
        now: w.clock.now(),
        params: {},
        waitUntil: () => {},
      };
    };
    // The floor form, as a later large route could take it by mistake.
    const floorForm = (ctx: RouteContext) =>
      managedCall(
        ctx.config,
        ctx,
        managedBody(z.strictObject({})),
        async () => "o-any",
        async () => ok(null),
        () => json({}),
      );
    const large = contextOf("POST /sso/connections/create", "/sso/connections/create");
    await expect(floorForm(large)).rejects.toThrow(
      "authtempo: a route with a cap above the floor must name its row before the read (managedLargeCall)",
    );
    expect(large.request.bodyUsed).toBe(false);
    // At the floor the form runs: a request with no session answers 401.
    const floor = await floorForm(contextOf("POST /sso/domains/update", "/sso/domains/update"));
    expect([floor.status, await floor.json()]).toEqual([401, { error: "unauthorized" }]);
  });
});
