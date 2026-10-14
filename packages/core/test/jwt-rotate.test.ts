import { describe, expect, it } from "vitest";
import { publicKeySet, signToken, verifyLocal } from "../src/engine/jwt.js";
import { decodeJws } from "../src/primitives/jwk.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { makeAuth } from "./helpers.js";

const DAY = 86_400_000;
type Auth = ReturnType<typeof makeAuth>;

const sign = (auth: Auth) => signToken(auth.config, "JWT", { sub: "u" });
const kidOf = (token: string) => decodeJws(token)?.header.kid;
const kids = async (auth: Auth) => (await publicKeySet(auth.config)).keys.map((k) => k.kid);

describe("jwtMint.rotateEvery (plan 11c)", () => {
  it("is off by default: a key 400 days old still signs", async () => {
    const auth = makeAuth();
    const first = kidOf(await sign(auth));
    auth.clock.advance(400 * DAY);
    expect(kidOf(await sign(auth))).toBe(first);
    expect(await auth.storage.findMany("jwk", [])).toHaveLength(1);
  });

  it("signs with a new key once the key is rotateEvery days old, and the old key verifies for 24 hours", async () => {
    const auth = makeAuth({ jwtMint: { rotateEvery: 30 } });
    const old = await sign(auth);
    auth.clock.advance(30 * DAY - 1);
    expect(kidOf(await sign(auth))).toBe(kidOf(old));
    auth.clock.advance(1);
    const next = kidOf(await sign(auth));
    expect(next).not.toBe(kidOf(old));
    expect(await kids(auth)).toEqual([next, kidOf(old)]);
    expect(await verifyLocal(auth.config, old)).not.toBeNull();
    auth.clock.advance(DAY);
    expect(await kids(auth)).toEqual([next]);
    expect(await verifyLocal(auth.config, old)).toBeNull();
  });

  it("never rotates on a JWKS read: the timer runs on the signing path only", async () => {
    const auth = makeAuth({ jwtMint: { rotateEvery: 1 } });
    const first = kidOf(await sign(auth));
    auth.clock.advance(5 * DAY);
    expect(await kids(auth)).toEqual([first]);
    expect(kidOf(await sign(auth))).not.toBe(first);
  });

  it("leaves one new key when four signatures pass the interval at once", async () => {
    const auth = makeAuth({ jwtMint: { rotateEvery: 7 } });
    const first = kidOf(await sign(auth));
    auth.clock.advance(7 * DAY);
    const tokens = await Promise.all(Array.from({ length: 4 }, () => sign(auth)));
    const signedWith = new Set(tokens.map(kidOf));
    expect(signedWith.size).toBe(1);
    expect(signedWith.has(first)).toBe(false);
    const rows = await auth.storage.findMany("jwk", []);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.slot === "signing")).toHaveLength(1);
  });

  it("a signature that read the old key before another signature rotated it signs with the winner's key", async () => {
    // The claim, step by step: the loser holds the old row while the winner
    // retires it and writes the new key. The loser's retire then matches no
    // row by id and slot, and it reads the winner's key. A retire by slot
    // alone retires the winner's key and makes a second one.
    const storage = createMemoryAdapter();
    let interleave: (() => Promise<unknown>) | null = null;
    const held = new Proxy(storage, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "findOne" || typeof value !== "function") return value;
        return async (model: string, ...args: unknown[]) => {
          const row = await (value as (...a: unknown[]) => Promise<unknown>).call(
            target,
            model,
            ...args,
          );
          if (model === "jwk" && interleave) {
            const run = interleave;
            interleave = null;
            await run();
          }
          return row;
        };
      },
    }) as StorageAdapter;
    const auth = makeAuth({ storage: held, jwtMint: { rotateEvery: 7 } });
    const first = kidOf(await sign(auth));
    auth.clock.advance(7 * DAY);
    let winner: string | undefined;
    interleave = async () => {
      winner = kidOf(await sign(auth));
    };
    const loser = kidOf(await sign(auth));
    expect(interleave).toBeNull();
    expect(winner).toBeDefined();
    expect(winner).not.toBe(first);
    expect(loser).toBe(winner);
    expect(await storage.findMany("jwk", [])).toHaveLength(2);
  });
});
