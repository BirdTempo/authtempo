import { createMemoryAdapter, createMemoryLimiter, systemClock } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { BetterAuthCompatError } from "../src/compat-error.js";
import { organization } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
import { sso } from "../src/sso.js";
import type { BetterAuthOptions, CompatDatabase } from "../src/types.js";

// The base URL of Better Auth on core's list (plan 12i Task 18, spec 32 item 18).

const SECRET = "0123456789abcdef0123456789abcdef";

const memory = (): CompatDatabase => ({
  kind: "authtempo-compat-database",
  dialect: "postgres",
  storage: createMemoryAdapter(),
  limiter: createMemoryLimiter(systemClock),
});

/** The options of an app with one base URL form. */
const options = (baseURL: NonNullable<BetterAuthOptions["baseURL"]>): BetterAuthOptions => ({
  baseURL,
  basePath: "/api/auth",
  secret: SECRET,
  trustedOrigins: [],
  database: memory(),
});

const baseRefusals = (o: BetterAuthOptions) =>
  checkOptions(o).refusals.filter((r) => r.startsWith("baseURL"));

describe("the base URL list through the shim (plan 12i Task 18)", () => {
  it("builds consumerd's options of each environment", async () => {
    // consumerd c43c307 (read 2026-10-24): baseURL env.API_URL and basePath /api/auth,
    // with API_URL one origin per wrangler environment.
    for (const url of [
      "http://localhost:8787",
      "https://staging.aestro.ai",
      "https://api.aestro.ai",
    ]) {
      expect(checkOptions(options(url)).refusals).toEqual([]);
      const auth = betterAuth(options(url));
      expect(auth.tempo.baseURL).toBe(url);
      expect(auth.tempo.basePath).toBe("/api/auth");
      const res = await auth.handler(new Request(`${url}/api/auth/get-session`));
      expect(res.status).toBe(200);
    }
  });

  it("maps exact allowedHosts with a protocol to core's list", async () => {
    const o = options({ allowedHosts: ["a.example", "b.example"], protocol: "https" });
    expect(baseRefusals(o)).toEqual([]);
    expect(mapOptions(o).config.baseURL).toEqual(["https://a.example", "https://b.example"]);
    const auth = betterAuth(o);
    expect(auth.tempo.baseURL).toBe("https://a.example");
    const onB = await auth.handler(new Request("https://b.example/api/auth/get-session"));
    expect(onB.status).toBe(200);
    // A host outside the list: core's 421, never the fallback of Better Auth.
    const other = await auth.handler(
      new Request("https://c.example/api/auth/get-session", {
        headers: { "x-forwarded-host": "a.example" },
      }),
    );
    expect(other.status).toBe(421);
    const local = options({ allowedHosts: ["localhost:8787"], protocol: "http" });
    expect(mapOptions(local).config.baseURL).toEqual(["http://localhost:8787"]);
  });

  // C M2 of the plan 12i final fix wave (probe C2 of final-12i-C). Better
  // Auth 1.7.2 trusts each allowed host (dist/context/helpers.mjs:60-71, read 2026-10-25).
  it("trusts each entry of the list as an origin, as Better Auth does, beside the app's list", async () => {
    const o = {
      ...options({ allowedHosts: ["a.example", "b.example"], protocol: "https" }),
      trustedOrigins: ["https://app.example", "https://a.example"],
    };
    expect(mapOptions(o).config.trustedOrigins).toEqual([
      "https://app.example",
      "https://a.example",
      "https://b.example",
    ]);
    const auth = betterAuth(o);
    const post = (from: string) =>
      auth.handler(
        new Request("https://b.example/api/auth/sign-out", {
          method: "POST",
          headers: { "content-type": "application/json", origin: from },
          body: "{}",
        }),
      );
    const fromA = await post("https://a.example");
    const fromOther = await post("https://evil.example");
    expect([fromA.status, fromOther.status, (await fromOther.json()).code]).toEqual([
      200,
      403,
      "INVALID_ORIGIN",
    ]);
  });

  it("refuses a wildcard host and protocol auto with their reasons", () => {
    expect(
      baseRefusals(options({ allowedHosts: ["a.example", "*.vercel.app"], protocol: "https" })),
    ).toEqual([
      "baseURL.allowedHosts[1]: a wildcard is refused: any customer of a shared platform can own a matching host and then holds a host of the issuer; list each exact host",
    ]);
    expect(baseRefusals(options({ allowedHosts: ["a.example"], protocol: "auto" }))).toEqual([
      'baseURL.protocol: auto reads x-forwarded-proto, which a client sets; core reads no proxy header, so set "https" (or "http" on localhost)',
    ]);
    // Better Auth's default protocol is auto.
    expect(baseRefusals(options({ allowedHosts: ["a.example"] }))).toEqual([
      'baseURL.protocol: required: Better Auth\'s default auto reads x-forwarded-proto, which a client sets; set "https" (or "http" on localhost)',
    ]);
    expect(
      baseRefusals(options({ allowedHosts: ["https://a.example/x"], protocol: "https" })),
    ).toEqual(["baseURL.allowedHosts[0]: expected an exact host, with no scheme, path, or user"]);
    expect(() =>
      betterAuth(options({ allowedHosts: ["*.vercel.app"], protocol: "https" })),
    ).toThrow(BetterAuthCompatError);
    // Core refuses http on a public host at start, with its own message.
    expect(() => betterAuth(options({ allowedHosts: ["a.example"], protocol: "http" }))).toThrow(
      /must be https, or http on localhost or 127.0.0.1/,
    );
  });

  it("makes a fallback equal to an entry the primary", () => {
    const o = options({
      allowedHosts: ["a.example", "b.example"],
      fallback: "https://b.example",
      protocol: "https",
    });
    expect(baseRefusals(o)).toEqual([]);
    expect(mapOptions(o).config.baseURL).toEqual(["https://b.example", "https://a.example"]);
    expect(betterAuth(o).tempo.baseURL).toBe("https://b.example");
    expect(
      baseRefusals(
        options({ allowedHosts: ["a.example"], fallback: "https://c.example", protocol: "https" }),
      ),
    ).toEqual([
      "baseURL.fallback: must be one origin of allowedHosts: core answers 421 to any other host and builds no URL from it",
    ]);
  });
});

describe("the shim on the second entry of the list (plan 12i Task 18)", () => {
  const A = "https://a.example";
  const B = "https://b.example";
  const listed = (extra: Partial<BetterAuthOptions> = {}): BetterAuthOptions => ({
    ...options({ allowedHosts: ["a.example", "b.example"], protocol: "https" }),
    ...extra,
  });
  /** A JSON POST from the page of `host` to `host`. */
  const post = (host: string, path: string, body: unknown = {}) =>
    new Request(`${host}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: host },
      body: JSON.stringify(body),
    });

  it("answers a shim path on B as on A: core's inner request runs on B", async () => {
    const auth = betterAuth(listed());
    for (const path of ["/revoke-sessions", "/sign-out"]) {
      const onA = await auth.handler(post(A, path));
      const onB = await auth.handler(post(B, path));
      expect([path, onB.status, await onB.text()]).toEqual([path, onA.status, await onA.text()]);
    }
    const revoke = await auth.handler(post(B, "/revoke-sessions"));
    expect(revoke.status).toBe(401);
    // The default landing origin is the request's entry too, as core's default appURL.
    const link = { provider: "github", callbackURL: `${B}/home` };
    // On B the URL passes and core's link route answers: no provider github here.
    const onB = await auth.handler(post(B, "/link-social", link));
    expect(onB.status).toBe(404);
    const onA = await auth.handler(post(A, "/link-social", link));
    expect([onA.status, ((await onA.json()) as { code: string }).code]).toEqual([
      403,
      "INVALID_CALLBACK_URL",
    ]);
  });

  it("mails the links of a request on B, and the send callbacks take them", async () => {
    const sent: string[] = [];
    const auth = betterAuth(
      listed({
        emailAndPassword: {
          enabled: true,
          sendResetPassword: async ({ url }) => void sent.push(url),
        },
        emailVerification: { sendVerificationEmail: async ({ url }) => void sent.push(url) },
      }),
    );
    const signUp = await auth.handler(
      post(B, "/password/sign-up", { email: "ada@example.com", password: "correct horse battery" }),
    );
    expect(signUp.status).toBe(200);
    const reset = await auth.handler(
      post(B, "/password/reset/request", { email: "ada@example.com" }),
    );
    expect(reset.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/^https:\/\/b\.example\/api\/auth\/password\/verify\?token=/);
    expect(sent[1]).toMatch(/^https:\/\/b\.example\/api\/auth\/password\/reset\?token=/);
  });

  it("answers 421 before the SAML ACS on a host outside the list, in Better Auth's shape", async () => {
    const auth = betterAuth(
      listed({
        authtempo: { ssoDns: [{ name: "a", txt: async () => [] }] },
        plugins: [organization({ sendInvitationEmail: async () => {} }), sso({})],
      }),
    );
    for (const request of [
      new Request("https://c.example/api/auth/sso/saml2/sp/acs/acme", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "SAMLResponse=x",
      }),
      new Request("https://c.example/api/auth/get-session"),
    ]) {
      const res = await auth.handler(request);
      expect(res.status).toBe(421);
      expect(await res.json()).toEqual({ code: "HOST_NOT_ALLOWED", message: "Host not allowed" });
    }
  });
});
