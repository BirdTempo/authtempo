import { describe, expect, it } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { routeKeyOf } from "../src/http/route-key.js";
import {
  ROUTE_FEATURES,
  ROUTER_CODES,
  ROUTES,
  type RouteEntry,
  type RouteFeature,
} from "../src/http/route-list.js";
import { coreRouteModules, coreRoutes, type RouteModule } from "../src/http/routes/index.js";
import { BASE, base, everyFeature, SOCIAL } from "./every-feature.js";

/** The key of a mounted route as `ROUTES` writes it (plan 11g: `routeKeyOf`). */
function templated(r: { method: string; path: string }): string {
  return routeKeyOf(r.method, r.path);
}

/** The platform organization of plan 12f, so the user tools have a user actor and no secret. */
const PLATFORM = {
  platformRole: "operator",
  platformOrganization: "platform-co",
  ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
};

/** The features that each route module serves (plan 11g). A route's entry must have one of them. */
const MODULE_FEATURES: Record<RouteModule, readonly RouteFeature[]> = {
  sessions: ["session", "account"],
  reauth: ["account", "passkey", "emailOtp"],
  user: ["account", "emailOtp", "accountDelete"],
  identities: ["account"],
  "magic-link": ["magicLink"],
  social: ["social"],
  passkeys: ["passkey"],
  password: ["password"],
  totp: ["totp"],
  "second-factor": ["totp"],
  "email-otp": ["emailOtp", "emailOtpReset"],
  handoff: ["handoff"],
  organizations: ["organizations"],
  tokens: ["tokens"],
  jwt: ["jwtMint"],
  operator: ["operator", "operatorUsers", "operatorImpersonation"],
  oauth: ["oauth", "oauthRegistration", "oauthDevice"],
  openapi: ["openapi"],
};

describe("ROUTES (plan 11a)", () => {
  it("the router serves exactly ROUTES when every feature is on", () => {
    const routes = coreRoutes(everyFeature());
    // The Set below folds the providers into one template, so it would also fold a route that is
    // mounted twice. Check the raw method and path first: each one is mounted once.
    const raw = routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(raw).size).toBe(raw.length);
    const served = [...new Set(routes.map(templated))].sort();
    const listed = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(served).toEqual([...listed].sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.length).toBe(121);
  });

  it("serves only the routes of the features that are on by default for a minimal config", () => {
    const served = coreRoutes(resolveConfig(base)).map(templated).sort();
    const always = new Set([
      "session",
      "account",
      "accountDelete",
      "magicLink",
      "emailOtp",
      "tokens",
      "jwtMint",
    ]);
    const listed = ROUTES.filter((r) => always.has(r.feature)).map((r) => `${r.method} ${r.path}`);
    expect(served).toEqual(listed.sort());
  });

  it("names each route's feature from the config that turns it on", () => {
    const withPassword = coreRoutes(resolveConfig({ ...base, password: {} })).map(templated);
    for (const r of ROUTES.filter((x) => x.feature === "emailOtpReset" || x.feature === "totp"))
      expect(withPassword).toContain(`${r.method} ${r.path}`);
  });

  /**
   * Each row is the smallest config change for a feature, and the features whose routes it turns
   * on. `password` also turns on `totp`, and `emailOtpReset` with the default `emailOtp`. `oauth`
   * with `registration.dynamic: true` also turns on `oauthRegistration`, which is off by default
   * since plan 12e. A row with `off` is a feature that is on by default: the change turns it off,
   * and the routes go. `start` is
   * the config that the change applies to, on top of `base`. With `start`, a row can isolate one
   * feature of a group: a row that turns on only a group cannot see a route tagged with the
   * wrong feature of that group.
   */
  const deltas: {
    name: string;
    start?: Partial<AuthConfig>;
    delta: Partial<AuthConfig>;
    features: RouteFeature[];
    off?: true;
  }[] = [
    { name: "social", delta: { social: SOCIAL }, features: ["social"] },
    {
      name: "passkey",
      delta: { passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE] } },
      features: ["passkey"],
    },
    { name: "password", delta: { password: {} }, features: ["password", "totp", "emailOtpReset"] },
    {
      name: "password alone",
      start: { totp: false, emailOtp: false },
      delta: { password: {} },
      features: ["password"],
    },
    {
      name: "totp off",
      start: { password: {} },
      delta: { totp: false },
      features: ["totp"],
      off: true,
    },
    {
      name: "emailOtp off with password",
      start: { password: {} },
      delta: { emailOtp: false },
      features: ["emailOtp", "emailOtpReset"],
      off: true,
    },
    { name: "handoff", delta: { handoff: { schemes: ["example://"] } }, features: ["handoff"] },
    { name: "organizations", delta: { organizations: {} }, features: ["organizations"] },
    {
      name: "oauth with dynamic registration",
      delta: {
        oauth: { resources: [`${BASE}/mcp`], registration: { cimd: false, dynamic: true } },
      },
      features: ["oauth", "oauthRegistration"],
    },
    {
      name: "oauth without dynamic registration",
      delta: {
        oauth: {
          resources: [`${BASE}/mcp`],
          registration: { dynamic: false },
          fetch: async () => new Response(),
        },
      },
      features: ["oauth"],
    },
    {
      name: "oauth device",
      start: {
        oauth: { resources: [`${BASE}/mcp`], registration: { cimd: false } },
      },
      delta: {
        oauth: { resources: [`${BASE}/mcp`], registration: { cimd: false }, device: {} },
      },
      features: ["oauthDevice"],
    },
    { name: "emailOtp off", delta: { emailOtp: false }, features: ["emailOtp"], off: true },
    { name: "jwtMint off", delta: { jwtMint: false }, features: ["jwtMint"], off: true },
    {
      name: "account delete off",
      delta: { account: { delete: false } },
      features: ["accountDelete"],
      off: true,
    },
    // The mailed confirm adds no route: its two routes come with the delete (plan 12a Task 20).
    { name: "account delete confirm on", delta: { account: { deleteConfirm: {} } }, features: [] },
    {
      name: "account delete off with the confirm on",
      start: { account: { deleteConfirm: {} } },
      delta: { account: { delete: false, deleteConfirm: {} } },
      features: ["accountDelete"],
      off: true,
    },
    {
      name: "operator",
      delta: { operator: { secretHash: "0".repeat(64) } },
      features: ["operator"],
    },
    {
      name: "operator users with a secret",
      start: { operator: { secretHash: "0".repeat(64) } },
      delta: {
        operator: {
          secrets: [{ name: "support", secretHash: "0".repeat(64), scopes: ["users"] }],
          users: true,
        },
      },
      features: ["operatorUsers"],
    },
    // Ruling 22 of plan 12f: with no secret entry, the four secret routes are off.
    {
      name: "operator users with a platform role and no secret",
      start: { organizations: PLATFORM },
      delta: { organizations: PLATFORM, operator: { users: true } },
      features: ["operatorUsers"],
    },
    {
      name: "operator impersonation",
      start: {
        organizations: { platformRole: "owner", platformOrganization: "platform-co" },
        operator: { secretHash: "0".repeat(64), users: true },
      },
      delta: {
        organizations: { platformRole: "owner", platformOrganization: "platform-co" },
        operator: { secretHash: "0".repeat(64), users: true, impersonation: {} },
      },
      features: ["operatorImpersonation"],
    },
    // A platform operator starts it with a session, so no secret entry is needed.
    {
      name: "operator impersonation with no secret",
      start: { organizations: PLATFORM, operator: { users: true } },
      delta: { organizations: PLATFORM, operator: { users: true, impersonation: {} } },
      features: ["operatorImpersonation"],
    },
    { name: "openapi", delta: { openapi: true }, features: ["openapi"] },
  ];

  it.each(deltas)(
    "the $name change adds or removes exactly the routes of its features",
    ({ start, delta, features, off }) => {
      const first = { ...base, ...start };
      const before = new Set(coreRoutes(resolveConfig(first)).map(templated));
      const after = new Set(coreRoutes(resolveConfig({ ...first, ...delta })).map(templated));
      const [from, to] = off ? [after, before] : [before, after];
      const changed = [...to].filter((k) => !from.has(k)).sort();
      const tagged = ROUTES.filter((r) => features.includes(r.feature)).map(
        (r) => `${r.method} ${r.path}`,
      );
      expect(changed).toEqual(tagged.sort());
      // The change only adds (or, for `off`, only removes): no route of another feature moves.
      expect([...from].filter((k) => !to.has(k))).toEqual([]);
    },
  );
});

describe("the entry fields and the module tie (plan 11g)", () => {
  const entries = new Map(ROUTES.map((r) => [`${r.method} ${r.path}`, r]));

  it("ties each mounted route to its entry by key", () => {
    const modules = coreRouteModules(everyFeature());
    expect(modules.length).toBe(Object.keys(MODULE_FEATURES).length);
    const mounted = new Map<string, number>();
    for (const { module, routes } of modules)
      for (const route of routes) {
        const where = `${module} ${route.method} ${route.path}`;
        const key: string = routeKeyOf(route.method, route.path);
        // A core route with no key is a failure, never a skip (ruling 3).
        expect(route.key, `${where} has no key`).toBeDefined();
        expect(route.key, `${where} has the key ${route.key}, not ${key}`).toBe(key);
        expect(entries.has(key), `${where}: ROUTES has no entry ${key}`).toBe(true);
        mounted.set(key, (mounted.get(key) ?? 0) + 1);
      }
    // Both ways: each entry is the key of exactly one route, or of one route per configured
    // provider for a `:provider` template. Apple's callback is the POST entry, not the GET template.
    const providers = everyFeature().social.providers.length;
    for (const key of entries.keys()) {
      const template = key.includes("/:provider/");
      const want = !template ? 1 : key.endsWith("/callback") ? providers - 1 : providers;
      const got = mounted.get(key) ?? 0;
      expect(got, `${key} is the key of ${got} routes, not ${want}`).toBe(want);
    }
  });

  it("tags each route with a feature of its module", () => {
    for (const { module, routes } of coreRouteModules(everyFeature()))
      for (const route of routes) {
        const feature = route.key === undefined ? undefined : entries.get(route.key)?.feature;
        expect(
          feature !== undefined && MODULE_FEATURES[module].includes(feature),
          `${route.key} has the feature ${feature}, not one of the module ${module}`,
        ).toBe(true);
      }
  });

  it("marks the cross-site form posts both ways", () => {
    const crossSite = coreRoutes(everyFeature())
      .filter((r) => r.allowCrossSiteForm === true)
      .map((r) => routeKeyOf(r.method, r.path))
      .sort();
    const marked = ROUTES.filter((r) => "crossSiteForm" in r && r.crossSiteForm === true)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(crossSite).toEqual(marked);
    expect(marked).toEqual(["POST /oauth/end-session", "POST /social/apple/callback"]);
  });

  it("names each code once and no router code", () => {
    const router: readonly string[] = ROUTER_CODES;
    // The entry type, not the literal tuple: a literal `codes` of `[]` has no member to read.
    const listed: readonly RouteEntry[] = ROUTES;
    for (const r of listed) {
      const key = `${r.method} ${r.path}`;
      expect(new Set(r.codes).size, key).toBe(r.codes.length);
      expect(new Set(r.oauthCodes).size, key).toBe(r.oauthCodes.length);
      expect(
        r.codes.filter((c) => router.includes(c)),
        key,
      ).toEqual([]);
      if (r.auth.length === 1 && r.auth[0] === "none")
        expect(r.codes.includes("unauthorized"), key).toBe(false);
    }
  });

  it("lists every feature once in ROUTE_FEATURES", () => {
    expect(new Set(ROUTE_FEATURES).size).toBe(ROUTE_FEATURES.length);
    expect(new Set(ROUTES.map((r) => r.feature))).toEqual(new Set(ROUTE_FEATURES));
  });
});
