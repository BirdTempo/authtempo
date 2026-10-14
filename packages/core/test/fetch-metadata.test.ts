import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/http/route-list.js";
import { createRouter, fetchMetadataRefuses } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { BASE, everyFeature } from "./every-feature.js";

const TRUSTED = "https://app.example.com";
// "bogus" is a value that the Fetch standard does not define: the code refuses such a form and
// passes such JSON.
const SITES = [null, "same-origin", "none", "same-site", "cross-site", "bogus"] as const;
const TYPES = [
  "application/json",
  "application/json; charset=utf-8",
  "Application/JSON",
  "application/x-www-form-urlencoded",
  "multipart/form-data; boundary=x",
  "text/plain",
  null,
] as const;
const ORIGINS = [null, TRUSTED] as const;

function request(
  path: string,
  site: string | null,
  type: string | null,
  origin: string | null,
): Request {
  const headers: Record<string, string> = {};
  if (site !== null) headers["sec-fetch-site"] = site;
  if (type !== null) headers["content-type"] = type;
  if (origin !== null) headers.origin = origin;
  return new Request(`${BASE}${path}`, { method: "POST", headers, body: "{}" });
}

/** The rule of plan 12b, written out once, to hold the code to. */
function expected(site: string | null, type: string | null, trusted: boolean): boolean {
  if (site === null) return false;
  const json = (type ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
  if (!json) return site !== "same-origin" && site !== "none";
  return (site === "cross-site" || site === "same-site") && !trusted;
}

describe("fetchMetadataRefuses (plan 12b)", () => {
  it.each(
    SITES.flatMap((site) =>
      TYPES.flatMap((type) => ORIGINS.map((origin) => ({ site, type, origin }))),
    ),
  )("site $site, type $type, origin $origin", ({ site, type, origin }) => {
    const trusted = origin === TRUSTED;
    expect(fetchMetadataRefuses(request("/x", site, type, origin), trusted)).toBe(
      expected(site, type, trusted),
    );
  });
});

describe("the router applies it on every POST route (plan 12b)", () => {
  const config = everyFeature();
  const handle = createRouter(
    { ...config, trustedOrigins: new Set([TRUSTED]) },
    coreRoutes(config),
  );
  const posts = ROUTES.filter((r) => r.method === "POST").map((r) =>
    r.path.replace(":provider", "google"),
  );

  it("lists every POST route of ROUTES", () => {
    expect(posts.length).toBe(ROUTES.filter((r) => r.method === "POST").length);
    expect(posts.length).toBeGreaterThan(40);
  });

  it.each(posts)("refuses a cross-site form post on %s", async (path) => {
    const res = await handle(
      // A trusted Origin: a browser on a trusted app sends this, and only the new rule refuses it.
      request(
        `${config.basePath}${path}`,
        "cross-site",
        "application/x-www-form-urlencoded",
        TRUSTED,
      ),
    );
    // Apple's callback is the one POST that a provider sends cross-site (allowCrossSiteForm).
    // The token endpoint (clientOrigin, plan 11d) reads no cookie, so a post with an Origin
    // skips the rule there; oauth-cors.test.ts holds its cases.
    // /handoff/continue and /oauth/authorize answer the same 403 from their own handlers, so on
    // those two routes this case cannot tell the router from the handler. The stub route test
    // below closes that gap: its handler never refuses.
    if (path === "/social/apple/callback" || path === "/oauth/token") {
      expect(res.status).not.toBe(403);
      return;
    }
    expect({ path, status: res.status, body: await res.json() }).toEqual({
      path,
      status: 403,
      body: { error: "origin_not_trusted" },
    });
  });

  it.each(posts)("passes a post with no Sec-Fetch-Site on %s to its handler", async (path) => {
    // Two routes have their own stricter check: their Origin must be baseURL.
    const origin = path === "/handoff/continue" || path === "/oauth/authorize" ? BASE : TRUSTED;
    const res = await handle(
      request(`${config.basePath}${path}`, null, "application/json", origin),
    );
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { error?: string };
    expect({ path, refused: body.error === "origin_not_trusted" }).toEqual({
      path,
      refused: false,
    });
  });

  it("passes a cross-site JSON post from a trusted origin, and refuses it with no origin", async () => {
    const path = `${config.basePath}/magic-link/request`;
    // The body "{}" has no email, so the handler answers 400: the router let it through.
    const trusted = await handle(request(path, "cross-site", "application/json", TRUSTED));
    expect(trusted.status).toBe(400);
    const bare = await handle(request(path, "cross-site", "application/json", null));
    expect({ status: bare.status, body: await bare.json() }).toEqual({
      status: 403,
      body: { error: "origin_not_trusted" },
    });
  });
});

describe("the router refuses before any handler runs (plan 12b)", () => {
  it("refuses a cross-site form post on a stub route, and never calls its handler", async () => {
    const config = everyFeature();
    let calls = 0;
    const handle = createRouter({ ...config, trustedOrigins: new Set([TRUSTED]) }, [
      {
        method: "POST",
        path: "/x",
        async handler() {
          calls += 1;
          return new Response(null, { status: 204 });
        },
      },
    ]);
    const path = `${config.basePath}/x`;
    const form = "application/x-www-form-urlencoded";
    const refused = await handle(request(path, "cross-site", form, TRUSTED));
    expect({ status: refused.status, body: await refused.json(), calls }).toEqual({
      status: 403,
      body: { error: "origin_not_trusted" },
      calls: 0,
    });
    // The same form from this origin reaches the handler: the stub route is mounted.
    const passed = await handle(request(path, "same-origin", form, null));
    expect({ status: passed.status, calls }).toEqual({ status: 204, calls: 1 });
  });
});
