import { decodeProtectedHeader } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJwtAuth } from "../guides/jwt.ts";
import { call, harness, signIn } from "../support/harness.ts";
import { rotateSigningKey } from "./key-rotation.ts";

// The retired key verifies for this long (RETIRED_KEY_MS of core).
const DAY_MS = 86_400_000;

describe("key rotation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("drops the old key from the key set after 24 hours, and the sweep deletes it", async () => {
    // Only Date is fake: core's default clock reads it, and the crypto keeps its real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();
    const auth = createJwtAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    await call(auth, "GET", "/auth/token", undefined, { cookie: ada });
    const keys = async () =>
      (
        (await (await call(auth, "GET", "/auth/jwks")).json()) as { keys: { kid: string }[] }
      ).keys.map((k) => k.kid);
    const newKid = await rotateSigningKey(auth);
    const rotatedAt = Date.now();

    vi.setSystemTime(rotatedAt + DAY_MS - 60_000);
    expect(await keys()).toHaveLength(2);
    expect((await auth.api.sweepExpired()).jwks).toBe(0);

    vi.setSystemTime(rotatedAt + DAY_MS + 60_000);
    expect(await keys()).toEqual([newKid]);
    expect((await auth.api.sweepExpired()).jwks).toBe(1);
  });
});
