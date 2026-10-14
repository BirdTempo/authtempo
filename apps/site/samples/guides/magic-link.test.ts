import { describe, expect, it } from "vitest";
import { call, harness, lastMailTo, linkIn } from "../support/harness.ts";
import { createMagicLinkAuth } from "./magic-link.ts";

describe("sign in with a magic link", () => {
  it("mails a link, shows a confirm page with no side effect, and opens a session on the post", async () => {
    const h = harness();
    const auth = createMagicLinkAuth(h);
    const ask = await call(auth, "POST", "/auth/magic-link/request", {
      email: "ada@example.com",
      next: "/home",
    });
    expect(await ask.json()).toEqual({ sent: true });
    expect(lastMailTo(h, "ada@example.com").subject).toBe("Sign in to Example");

    const link = linkIn(h, "ada@example.com");
    for (let i = 0; i < 2; i++) {
      const page = await auth.handle(new Request(link));
      expect(page.status).toBe(200);
      expect(page.headers.get("set-cookie")).toBeNull();
    }
    const token = link.searchParams.get("token") ?? "";
    const verify = await call(auth, "POST", "/auth/magic-link/verify", { token });
    expect(verify.status).toBe(200);
    expect(((await verify.json()) as { user: { email: string } }).user.email).toBe(
      "ada@example.com",
    );

    const again = await call(auth, "POST", "/auth/magic-link/verify", { token });
    expect(await again.json()).toEqual({ error: "invalid_token" });
  });

  it("answers the same for an address with no account", async () => {
    const auth = createMagicLinkAuth(harness());
    const ask = await call(auth, "POST", "/auth/magic-link/request", {
      email: "nobody@example.com",
    });
    expect(await ask.json()).toEqual({ sent: true });
  });
});
