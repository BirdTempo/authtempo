import { describe, expect, it } from "vitest";
import type { JwtSeam } from "../src/seams/jwt.js";
import { appleProvider } from "../src/social/apple.js";
import { googleProvider } from "../src/social/google.js";
import { buildQuery } from "../src/social/provider.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("buildQuery", () => {
  it("encodes a space as %20, not +, because Apple rejects + in scope", () => {
    expect(buildQuery({ scope: "name email", a: "x&y=z" })).toBe("scope=name%20email&a=x%26y%3Dz");
  });
});

describe("google provider", () => {
  const google = googleProvider({ clientId: "gid", clientSecret: "gsecret" });
  it("has the Google endpoints, both issuers, and a GET callback", () => {
    expect(google.kind).toBe("oidc");
    expect(google.label).toBe("Continue with Google");
    expect(google.authorizeUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(google.jwksUrl).toBe("https://www.googleapis.com/oauth2/v3/certs");
    expect(google.issuer).toEqual(["https://accounts.google.com", "accounts.google.com"]);
    expect(google.scope).toBe("openid email profile");
    expect(google.authorizeParams).toEqual({});
    expect(google.callbackMethod).toBe("GET");
  });
  it("returns the static client secret", async () => {
    const jwt = {} as JwtSeam;
    expect(await google.clientSecret({ jwt, now: NOW })).toBe("gsecret");
  });
  it("maps claims and trusts email_verified only when it is boolean true", () => {
    expect(
      google.profile(
        {
          sub: "123",
          email: "Ada@Example.com",
          email_verified: true,
          name: "Ada",
          picture: "https://p/x.png",
        },
        {},
      ),
    ).toEqual({
      subject: "123",
      email: "Ada@Example.com",
      emailVerified: true,
      name: "Ada",
      image: "https://p/x.png",
    });
    expect(
      google.profile({ sub: "123", email: "a@b.co", email_verified: "true" }, {}),
    ).toMatchObject({
      emailVerified: false,
      name: null,
      image: null,
    });
    expect(google.profile({ sub: 5 }, {})).toMatchObject({
      subject: "",
      email: null,
      emailVerified: false,
    });
  });
});

describe("apple provider", () => {
  const apple = appleProvider({
    clientId: "com.example.web",
    teamId: "TEAM1",
    keyId: "KEY1",
    privateKey: "pem",
  });
  it("has the Apple endpoints, form_post, and a POST callback", () => {
    expect(apple.kind).toBe("oidc");
    expect(apple.label).toBe("Continue with Apple");
    expect(apple.authorizeUrl).toBe("https://appleid.apple.com/auth/authorize");
    expect(apple.tokenUrl).toBe("https://appleid.apple.com/auth/token");
    expect(apple.jwksUrl).toBe("https://appleid.apple.com/auth/keys");
    expect(apple.issuer).toEqual(["https://appleid.apple.com"]);
    expect(apple.scope).toBe("name email");
    expect(apple.authorizeParams).toEqual({ response_mode: "form_post" });
    expect(apple.callbackMethod).toBe("POST");
  });
  it("signs a five-minute client secret on every call with the team, key, and client ids", async () => {
    const calls: Array<{ privateKeyPem: string; keyId: string; payload: Record<string, unknown> }> =
      [];
    const jwt: JwtSeam = {
      verifyIdToken: async () => ({}),
      signES256: async (input) => {
        calls.push(input);
        return `signed-${calls.length}`;
      },
    };
    expect(await apple.clientSecret({ jwt, now: NOW })).toBe("signed-1");
    expect(await apple.clientSecret({ jwt, now: NOW })).toBe("signed-2");
    expect(calls[0]).toEqual({
      privateKeyPem: "pem",
      keyId: "KEY1",
      payload: {
        iss: "TEAM1",
        sub: "com.example.web",
        aud: "https://appleid.apple.com",
        iat: 1_767_225_600,
        exp: 1_767_225_900,
      },
    });
  });
  it("takes the name from the user field on the first sign-in and accepts email_verified as true or 'true'", () => {
    const user = JSON.stringify({
      name: { firstName: "Ada", lastName: "Lovelace" },
      email: "a@privaterelay.appleid.com",
    });
    expect(
      apple.profile(
        { sub: "001.abc", email: "a@privaterelay.appleid.com", email_verified: "true" },
        { user },
      ),
    ).toEqual({
      subject: "001.abc",
      email: "a@privaterelay.appleid.com",
      emailVerified: true,
      name: "Ada Lovelace",
      image: null,
    });
    expect(
      apple.profile({ sub: "001.abc", email: "a@x.io", email_verified: true }, {}),
    ).toMatchObject({
      emailVerified: true,
      name: null,
    });
  });
  it("survives a malformed or empty user field (Review Focus 5)", () => {
    for (const user of [
      "{not json",
      "[]",
      "null",
      JSON.stringify({ name: { firstName: "", lastName: " " } }),
      JSON.stringify({ name: "Ada" }),
    ]) {
      expect(
        apple.profile({ sub: "001.abc", email: "a@x.io", email_verified: true }, { user }),
      ).toMatchObject({
        subject: "001.abc",
        name: null,
      });
    }
  });
});
