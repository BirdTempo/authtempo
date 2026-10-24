import { describe, expect, it } from "vitest";
import { call, harness, linkIn, sessionCookieOf } from "../support/harness.ts";
import { type Carts, createGuestAuth } from "./anonymous.ts";

describe("anonymous sessions", () => {
  it("moves the guest cart into the account at a magic link in the same browser", async () => {
    const h = harness();
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

  it("refuses a way in on a guest session", async () => {
    const auth = createGuestAuth(harness());
    const cookie = sessionCookieOf(await call(auth, "POST", "/auth/anonymous/sign-in", {}));
    const res = await call(auth, "POST", "/auth/user/update", { name: "Ada" }, { cookie });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "anonymous_refused" });
  });
});
