import { describe, expect, it } from "vitest";
import { createAuth } from "../src/create-auth.js";
import {
  ACCESS_TOKEN_TYPE,
  API_TOKEN_PREFIX,
  DEFAULT_COOKIE_NAME,
  decodeJws,
  isResourceUrl,
  JWS_RE,
  LEGACY_COOKIE_NAME,
  readBearer,
  readSessionToken,
  resourceOf,
  SESSION_JWT_TYPE,
  SESSION_TOKEN_PREFIX,
  sessionCookieNames,
  verifyJws,
} from "../src/credentials.js";
import { mintSessionJwt, publicKeySet } from "../src/engine/jwt.js";
import { createSession } from "../src/engine/sessions.js";
import { createApiToken } from "../src/engine/tokens.js";
import {
  AUTH_ERROR_PARAM,
  PARAM_SEGMENT_RE,
  PROVIDER_NAME_RE,
  ROUTES,
  type RoutePath,
} from "../src/routes.js";
import { ROUTES as TESTING_ROUTES } from "../src/testing/soft-authenticator.js";
import { APP_ORIGIN, BASE_URL, makeAuth } from "./helpers.js";

/**
 * The one node:fs call of this file. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck (as sweep.test.ts does).
 */
interface PackageFs {
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

// Compile-time checks. tsc fails on an unused @ts-expect-error, so the two
// marked lines fail the typecheck when RoutePath widens to string, and the
// two plain lines fail when RoutePath narrows to never.
const sessionPath: RoutePath<"GET"> = "/session";
const signOutPath: RoutePath<"POST"> = "/sign-out";
// @ts-expect-error A path that ROUTES does not hold is not a RoutePath.
const typoPath: RoutePath<"GET"> = "/sesion";
// @ts-expect-error A POST route is not a GET path.
const wrongMethodPath: RoutePath<"GET"> = "/sign-out";

describe("the SDK entries of core (plan 11d)", () => {
  it("maps ./routes and ./credentials in the package exports, beside ./testing", async () => {
    const { readFileSync } = (await import(FS_MODULE)) as PackageFs;
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports["./routes"]).toEqual({
      types: "./dist/routes.d.ts",
      default: "./dist/routes.js",
    });
    expect(pkg.exports["./credentials"]).toEqual({
      types: "./dist/credentials.d.ts",
      default: "./dist/credentials.js",
    });
    expect(pkg.exports["./testing"]).toBeDefined();
  });

  it("serves one ROUTES list through ./routes and ./testing, with literal paths", () => {
    expect(TESTING_ROUTES).toBe(ROUTES);
    expect(Object.isFrozen(ROUTES)).toBe(true);
    // The values exist at run time too; the type lines above are the check.
    expect([sessionPath, signOutPath, typoPath, wrongMethodPath]).toEqual([
      "/session",
      "/sign-out",
      "/sesion",
      "/sign-out",
    ]);
    expect(PROVIDER_NAME_RE.test("google")).toBe(true);
    expect(PROVIDER_NAME_RE.test("Google")).toBe(false);
    // The segment rule of an SSO connection id and a SCIM id (plan 12d), for an SDK's start link.
    expect(PARAM_SEGMENT_RE.test("01JABCDEF")).toBe(true);
    expect(PARAM_SEGMENT_RE.test("urn:ietf:params:scim:schemas:core:2.0:User")).toBe(true);
    expect(PARAM_SEGMENT_RE.test("a/b")).toBe(false);
    expect(PARAM_SEGMENT_RE.test("a%2Fb")).toBe(false);
  });

  it("names the query parameter of a browser flow failure", async () => {
    const h = makeAuth();
    const auth = createAuth({
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      appURL: APP_ORIGIN,
      storage: h.storage,
      mail: { send: async () => {} },
      oauth: { resources: [`${BASE_URL}/mcp`], registration: { cimd: false, dynamic: true } },
    });
    // A sign-in step whose next is not an authorize URL fails to the app with the code.
    const res = await auth.handle(new Request(`${BASE_URL}/auth/oauth/sign-in?next=/elsewhere`));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.searchParams.get(AUTH_ERROR_PARAM)).toBe("invalid_request");
  });

  it("names the prefix and the typ of each credential that core issues", async () => {
    const h = makeAuth();
    const user = await h.seedUser("ada@example.com");
    const { token, session } = await createSession(h.config, {
      userId: user.id,
      ip: null,
      userAgent: null,
    });
    expect(token.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    const api = await createApiToken(h.config, { user, name: "ci" });
    if (!api.ok) throw new Error(api.code);
    expect(api.value.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    const jwt = await mintSessionJwt(h.config, { userId: user.id, sessionId: session.id });
    if (!jwt.ok) throw new Error(jwt.code);
    expect(JWS_RE.test(jwt.value.token)).toBe(true);
    const decoded = decodeJws(jwt.value.token);
    expect(decoded?.header.typ).toBe(SESSION_JWT_TYPE);
    const { keys } = await publicKeySet(h.config);
    const key = keys.find((k) => k.kid === decoded?.header.kid);
    if (!decoded || !key) throw new Error("no key for the token");
    expect(await verifyJws(decoded, key)).toBe(true);
    expect(ACCESS_TOKEN_TYPE).toBe("at+jwt");
  });

  it("reads the bearer header, and the cookie before the bearer", () => {
    const bearer = new Request(BASE_URL, { headers: { authorization: "Bearer tk_abc" } });
    expect(readBearer(bearer)).toBe("tk_abc");
    expect(readBearer(new Request(BASE_URL))).toBeNull();
    const both = new Request(BASE_URL, {
      headers: { authorization: "Bearer ts_bearer", cookie: `${DEFAULT_COOKIE_NAME}=ts_cookie` },
    });
    expect(readSessionToken({ cookieName: DEFAULT_COOKIE_NAME }, both)).toBe("ts_cookie");
    expect(readSessionToken({ cookieName: "other" }, both)).toBe("ts_bearer");
    // Plan 12b: the default name is `__Host-tempo_session`, and core reads the old name for one release.
    expect(DEFAULT_COOKIE_NAME).toBe("__Host-tempo_session");
    const legacy = new Request(BASE_URL, {
      headers: { authorization: "Bearer ts_bearer", cookie: `${LEGACY_COOKIE_NAME}=ts_old` },
    });
    const config = { cookieName: DEFAULT_COOKIE_NAME, legacyCookieName: LEGACY_COOKIE_NAME };
    expect(readSessionToken(config, legacy)).toBe("ts_old");
    expect(readSessionToken({ cookieName: DEFAULT_COOKIE_NAME }, legacy)).toBe("ts_bearer");
  });

  it("names the old cookie for the default name only", () => {
    const names = { cookieName: DEFAULT_COOKIE_NAME, legacyCookieName: LEGACY_COOKIE_NAME };
    expect(sessionCookieNames()).toEqual(names);
    expect(sessionCookieNames(undefined)).toEqual(names);
    expect(sessionCookieNames(DEFAULT_COOKIE_NAME)).toEqual(names);
    expect(sessionCookieNames("app_session")).toEqual({
      cookieName: "app_session",
      legacyCookieName: null,
    });
    // The config resolves the two names with this one rule.
    const h = makeAuth();
    expect([h.config.cookieName, h.config.legacyCookieName]).toEqual([
      DEFAULT_COOKIE_NAME,
      LEGACY_COOKIE_NAME,
    ]);
    const custom = makeAuth({ cookieName: "app_session" });
    expect(custom.config.legacyCookieName).toBeNull();
  });

  it("finds the resource that a URL falls under, the longest path first", () => {
    const resources = [
      "https://api.example.com/mcp",
      "https://api.example.com/mcp/admin",
      "https://files.example.com",
    ];
    expect(resourceOf(resources, "https://api.example.com/mcp")).toBe(resources[0]);
    expect(resourceOf(resources, "https://api.example.com/mcp/tools")).toBe(resources[0]);
    expect(resourceOf(resources, "https://api.example.com/mcp/admin/x")).toBe(resources[1]);
    // A path that only starts with the same letters is not under the resource.
    expect(resourceOf(resources, "https://api.example.com/mcpx")).toBeNull();
    expect(resourceOf(resources, "https://files.example.com/a/b")).toBe(resources[2]);
    expect(resourceOf(resources, "https://other.example.com/mcp")).toBeNull();
    expect(resourceOf(resources, "not a url")).toBeNull();
  });

  it("skips a malformed resource, so a caller with no check gets null and no throw", () => {
    expect(isResourceUrl("https://api.example.com/mcp")).toBe(true);
    for (const bad of [
      "not a url",
      "ftp://api.example.com",
      "https://a.example.com/?q=1",
      "https://a.example.com/#x",
      7,
    ])
      expect(isResourceUrl(bad)).toBe(false);
    const resources = ["not a url", "https://api.example.com/?q=1", "https://api.example.com/mcp"];
    expect(resourceOf(resources, "https://api.example.com/mcp/tools")).toBe(resources[2]);
    expect(resourceOf(["not a url"], "https://api.example.com/mcp")).toBeNull();
  });
});
