import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { describe, expect, it } from "vitest";
import { call, harness, signIn } from "../support/harness.ts";
import { createJwtAuth } from "./jwt.ts";
import { verifySessionJwt } from "./jwt-verify.ts";

describe("mint a JWT for your other services", () => {
  it("mints a session JWT that another server verifies against the key set", async () => {
    const h = harness();
    const auth = createJwtAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const { token } = (await (
      await call(auth, "GET", "/auth/token", undefined, { cookie: ada })
    ).json()) as {
      token: string;
    };
    const keys = (await (await call(auth, "GET", "/auth/jwks")).json()) as JSONWebKeySet;
    const payload = await verifySessionJwt(token, createLocalJWKSet(keys));
    expect(payload.email).toBe("ada@example.com");
    expect(payload.plan).toBe("free");
    expect(typeof payload.sid).toBe("string");
  });
});
