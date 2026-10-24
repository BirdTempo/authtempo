import { createMemoryAdapter, createMemoryLimiter, systemClock } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { BetterAuthCompatError } from "../src/compat-error.js";
import { betterAuth } from "../src/server/better-auth.js";
import { checkOptions } from "../src/server/check-options.js";
import { mapOptions } from "../src/server/map-options.js";
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
