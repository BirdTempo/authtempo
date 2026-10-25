import { createMemoryLimiter, systemClock } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { call, harness, linkIn, sessionCookieOf } from "../support/harness.ts";
import { type Carts, createGuestAuth, moveGuestCart } from "./anonymous.ts";

/** A test passes the test value. An app passes the limiter of its adapter. */
const forTests = () => ({ ...harness(), limiter: "isolate-for-tests" as const });

describe("anonymous sessions", () => {
  it("moves the guest cart into the account at a magic link in the same browser", async () => {
    const h = forTests();
    const carts: Carts = new Map();
    const auth = createGuestAuth(h, carts);
    const guest = await call(auth, "POST", "/auth/anonymous/sign-in", {});
    const { user } = (await guest.json()) as { user: { id: string; email: string | null } };
    expect(user.email).toBeNull();
    carts.set(user.id, ["tea"]);

    // The request and the verify both carry the guest session cookie.
    const cookie = sessionCookieOf(guest);
    await call(auth, "POST", "/auth/magic-link/request", { email: "ada@example.com" }, { cookie });
    const token = linkIn(h, "ada@example.com").searchParams.get("token") ?? "";
    const res = await call(auth, "POST", "/auth/magic-link/verify", { token }, { cookie });
    const signedIn = (await res.json()) as { user: { id: string } };

    expect(carts.get(signedIn.user.id)).toEqual(["tea"]);
    expect(carts.has(user.id)).toBe(false);
  });

  it("moves no data on an unverified proof", () => {
    // A password sign-in with uniformSignUp false links with proof "unverified".
    const carts: Carts = new Map([["guest", ["tea"]]]);
    const move = moveGuestCart(carts);
    move({ anonymousUser: { id: "guest" }, user: { id: "claimant" }, proof: "unverified" });
    expect(carts.get("guest")).toEqual(["tea"]);
    expect(carts.has("claimant")).toBe(false);
    move({ anonymousUser: { id: "guest" }, user: { id: "owner" }, proof: "verified" });
    expect(carts.get("owner")).toEqual(["tea"]);
  });

  it("refuses a way in on a guest session", async () => {
    const auth = createGuestAuth(forTests());
    const cookie = sessionCookieOf(await call(auth, "POST", "/auth/anonymous/sign-in", {}));
    const res = await call(auth, "POST", "/auth/user/update", { name: "Ada" }, { cookie });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "anonymous_refused" });
  });

  it("refuses a memory limiter outside tests: the cap is per deployment", () => {
    const limiter = createMemoryLimiter(systemClock);
    expect(() => createGuestAuth({ ...harness(), limiter })).toThrow(/shared limiter/);
  });

  it("refuses a call with no limiter, as from plain JavaScript", () => {
    // The type needs a limiter. A call that skips the type check gets the refusal.
    const deps = harness() as never;
    expect(() => createGuestAuth(deps)).toThrow(/shared limiter/);
  });
});
