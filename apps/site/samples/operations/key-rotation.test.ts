import { decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";
import { createJwtAuth } from "../guides/jwt.ts";
import { call, harness, signIn } from "../support/harness.ts";
import { rotateSigningKey } from "./key-rotation.ts";

describe("key rotation", () => {
  it("signs with the new key, and keeps the old key in the key set for its tokens", async () => {
    const h = harness();
    const auth = createJwtAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const mint = async () =>
      (
        (await (await call(auth, "GET", "/auth/token", undefined, { cookie: ada })).json()) as {
          token: string;
        }
      ).token;
    const keys = async () =>
      (
        (await (await call(auth, "GET", "/auth/jwks")).json()) as { keys: { kid: string }[] }
      ).keys.map((k) => k.kid);

    const before = await mint();
    const oldKid = decodeProtectedHeader(before).kid;
    const newKid = await rotateSigningKey(auth);
    expect(newKid).not.toBe(oldKid);
    expect(decodeProtectedHeader(await mint()).kid).toBe(newKid);
    expect(await keys()).toEqual([newKid, oldKid]);
    expect((await auth.api.jwt?.verify(before))?.email).toBe("ada@example.com");
  });
});
