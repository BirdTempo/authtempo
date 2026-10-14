import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { readRedirectError } from "../src/redirect-error.js";
import { BASE_URL, inProcessFetch, makeServer } from "./harness.js";

describe("social sign-in and the redirect error (plan 11d)", () => {
  it("builds the start URL of a provider, with next, under basePath", () => {
    const client = createClient({ baseURL: `${BASE_URL}/`, basePath: "/api/auth" });
    expect(client.social.startURL({ provider: "google" })).toEqual({
      ok: true,
      value: `${BASE_URL}/api/auth/social/google/start`,
    });
    expect(client.social.startURL({ provider: "acme-sso", next: "/home?tab=1" })).toEqual({
      ok: true,
      value: `${BASE_URL}/api/auth/social/acme-sso/start?next=%2Fhome%3Ftab%3D1`,
    });
  });

  it("answers invalid_body for a provider name that core refuses, and navigates nowhere", () => {
    const went: string[] = [];
    const client = createClient({ baseURL: BASE_URL, navigate: (u) => went.push(u) });
    for (const provider of ["Google", "../evil", "", "a".repeat(33)])
      expect(client.social.signIn({ provider })).toEqual({
        ok: false,
        code: "invalid_body",
        status: 0,
      });
    expect(went).toEqual([]);
  });

  it("sends the browser to a start URL that core serves", async () => {
    const server = makeServer({
      social: { google: { clientId: "g", clientSecret: "s" } },
    });
    const went: string[] = [];
    const client = createClient({ baseURL: BASE_URL, navigate: (u) => went.push(u) });
    expect(client.social.signIn({ provider: "google", next: "/home" })).toEqual({
      ok: true,
      value: { url: `${BASE_URL}/auth/social/google/start?next=%2Fhome` },
    });
    const res = await inProcessFetch(server.auth).fetch(went[0] ?? "");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")?.startsWith("https://accounts.google.com/")).toBe(true);
  });

  it("reads the error code of a redirect, unknown as unexpected, and null when none", () => {
    const client = createClient({ baseURL: BASE_URL });
    expect(readRedirectError("https://app.example.com/?auth_error=invalid_token")).toBe(
      "invalid_token",
    );
    expect(
      client.readRedirectError(new URL("https://app.example.com/?auth_error=oauth_denied")),
    ).toBe("oauth_denied");
    expect(readRedirectError("/home?auth_error=brand_new")).toBe("unexpected");
    expect(readRedirectError("/home?auth_error=toString")).toBe("unexpected");
    expect(readRedirectError("https://app.example.com/home")).toBeNull();
  });
});

describe("social sign-in fix round (plan 11d Task 6 review)", () => {
  it("reads a code of core's OAuth table, which core's OAuth route sends (M3)", () => {
    expect(readRedirectError("https://app.example.com/?auth_error=invalid_request")).toBe(
      "invalid_request",
    );
  });

  it("answers unexpected when the default navigate finds no location (L2)", () => {
    expect(typeof (globalThis as { location?: unknown }).location).toBe("undefined");
    const client = createClient({ baseURL: BASE_URL });
    expect(client.social.signIn({ provider: "google" })).toEqual({
      ok: false,
      code: "unexpected",
      status: 0,
    });
  });
});
