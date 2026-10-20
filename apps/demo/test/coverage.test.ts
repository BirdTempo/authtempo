import { ROUTES, type RouteFeature } from "@authtempo/core/routes";
import { describe, expect, it } from "vitest";
import { DEMO_EXEMPT, DEMO_FEATURES } from "../src/facts.js";
import { call, LONG_TEST_MS, newSandbox } from "./helpers.js";

/**
 * Apple posts its callback to a path of its own. The route exists only with
 * the Apple preset, and the demo has the demo provider only.
 */
const APPLE_CALLBACK = "POST /social/apple/callback";

const demo = new Set<RouteFeature>(DEMO_FEATURES);
const exempt = new Set(Object.keys(DEMO_EXEMPT) as RouteFeature[]);

/** True when core's router has no route for the request: 404 with the code not_found. */
async function notFound(res: Response): Promise<boolean> {
  if (res.status !== 404) return false;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error === "not_found";
}

function request(route: (typeof ROUTES)[number]) {
  const path = `/auth${route.path.replace(":provider", "demo")}`;
  return { method: route.method, path, body: route.method === "POST" ? {} : undefined };
}

describe("the demo lists and the routes of core", () => {
  it(
    "serves every route of each demo feature",
    async () => {
      const jar = await newSandbox();
      const missing: string[] = [];
      let served = 0;
      for (const route of ROUTES) {
        if (!demo.has(route.feature)) continue;
        const key = `${route.method} ${route.path}`;
        const r = request(route);
        const res = await call(jar, r.method, r.path, r.body);
        if (key === APPLE_CALLBACK) {
          expect(await notFound(res)).toBe(true);
          continue;
        }
        if (await notFound(res)) missing.push(key);
        else served++;
      }
      expect(missing).toEqual([]);
      // Count what ran: the routes of the twelve demo features, less the Apple callback.
      // Plan 12k Task 3 added two organizations routes: has-permission and permissions.
      // Plan 12k Task 6 added one organizations route: check-slug.
      // Plan 12k Task 7 added one tokens route: update.
      expect(served).toBe(81);
    },
    LONG_TEST_MS,
  );

  it(
    "answers 404 for every route of an exempt feature",
    async () => {
      const jar = await newSandbox();
      const served: string[] = [];
      let checked = 0;
      for (const route of ROUTES) {
        if (!exempt.has(route.feature)) continue;
        const r = request(route);
        const res = await call(jar, r.method, r.path, r.body);
        if (!(await notFound(res))) served.push(`${route.method} ${route.path} ${res.status}`);
        checked++;
      }
      expect(served).toEqual([]);
      // Count what ran: the routes of the nine exempt features. Plan 12e added
      // three oauth routes (GET and POST /oauth/end-session, POST /oauth/introspect)
      // and the three routes of oauthDevice, so 24 became 30. Plan 12f adds the
      // eleven routes of operatorUsers and the two routes of
      // operatorImpersonation, so 30 became 43. Plan 12k Task 4 adds the five
      // routes of dynamicRoles, so 43 became 48. Plan 12k Task 5 adds the nine
      // routes of teams, so 48 became 57.
      expect(checked).toBe(57);
    },
    LONG_TEST_MS,
  );

  it("names every feature of ROUTES in one list", () => {
    const features = new Set(ROUTES.map((r) => r.feature));
    const named = new Set<RouteFeature>([...demo, ...exempt]);
    expect([...named].sort()).toEqual([...features].sort());
    expect([...demo].filter((f) => exempt.has(f))).toEqual([]);
  });
});
