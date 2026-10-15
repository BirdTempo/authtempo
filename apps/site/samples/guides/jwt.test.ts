import { createAuth } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { call, harness, signIn } from "../support/harness.ts";
import { createJwtAuth } from "./jwt.ts";
import { createJwtVerifier } from "./jwt-verify.ts";

const files = (token: string) =>
  new Request("https://files.example.com/doc", { headers: { authorization: `Bearer ${token}` } });

describe("mint a JWT for your other services", () => {
  it("mints a session JWT that another server verifies against the key set", async () => {
    const h = harness();
    const auth = createJwtAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const { token } = (await (
      await call(auth, "GET", "/auth/token", undefined, { cookie: ada })
    ).json()) as { token: string };
    const verifier = createJwtVerifier((input, init) => auth.handle(new Request(input, init)));
    const r = await verifier.verifyRequest(files(token));
    if (!r.ok || r.value?.kind !== "session-jwt") throw new Error("no caller");
    expect(r.value.email).toBe("ada@example.com");
    expect(r.value.claims.plan).toBe("free");
    expect(typeof r.value.sessionId).toBe("string");
  });

  it("refuses a token for another audience", async () => {
    // A config with no jwtMint.audience mints for baseURL, not for the files server.
    const h = harness();
    const auth = createAuth({
      baseURL: "https://api.example.com",
      trustedOrigins: [],
      secret: h.secret,
      storage: h.storage,
      mail: h.mail,
    });
    const ada = await signIn(auth, h, "ada@example.com");
    const { token } = (await (
      await call(auth, "GET", "/auth/token", undefined, { cookie: ada })
    ).json()) as { token: string };
    const verifier = createJwtVerifier((input, init) => auth.handle(new Request(input, init)));
    expect(await verifier.verifyRequest(files(token))).toEqual({ ok: true, value: null });
  });
});
