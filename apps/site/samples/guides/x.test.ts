import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createXAuth } from "./x.ts";

describe("sign in with X", () => {
  it("sends the person to the provider with the scope and a PKCE challenge", async () => {
    const auth = createXAuth(harness());
    const res = await call(auth, "GET", "/auth/social/twitter/start?next=/home");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(to.searchParams.get("scope")).toBe("users.read tweet.read users.email");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/social/twitter/callback",
    );
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
