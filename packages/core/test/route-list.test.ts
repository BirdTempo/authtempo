import { describe, expect, it } from "vitest";
import { type AuthConfig, resolveConfig } from "../src/config.js";
import { ROUTES, type RouteFeature } from "../src/http/route-list.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { BASE, base, everyFeature, SOCIAL } from "./every-feature.js";

/** A provider route as ROUTES writes it: one template for every provider, except Apple's POST callback. */
function templated(r: { method: string; path: string }): string {
  const social = /^\/social\/([a-z][a-z0-9-]*)\/(start|callback|link)$/.exec(r.path);
  // Apple's POST callback is its own entry; its link is not.
  if (social && !(r.method === "POST" && social[1] === "apple" && social[2] === "callback"))
    return `${r.method} /social/:provider/${social[2]}`;
  return `${r.method} ${r.path}`;
}

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
    expect(listed.length).toBe(94);
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
   * with the default `registration.dynamic` also turns on `oauthRegistration`. A row with `off`
   * is a feature that is on by default: the change turns it off, and the routes go. `start` is
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
      delta: { oauth: { resources: [`${BASE}/mcp`], registration: { cimd: false } } },
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
    { name: "emailOtp off", delta: { emailOtp: false }, features: ["emailOtp"], off: true },
    { name: "jwtMint off", delta: { jwtMint: false }, features: ["jwtMint"], off: true },
    {
      name: "account delete off",
      delta: { account: { delete: false } },
      features: ["accountDelete"],
      off: true,
    },
    {
      name: "operator",
      delta: { operator: { secretHash: "0".repeat(64) } },
      features: ["operator"],
    },
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
