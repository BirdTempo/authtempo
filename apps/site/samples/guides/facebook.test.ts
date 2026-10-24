import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createFacebookAuth } from "./facebook.ts";

describe("sign in with Facebook", () => {
  it("sends the person to the provider with the scope and a PKCE challenge", async () => {
    const auth = createFacebookAuth(harness());
    const res = await call(auth, "GET", "/auth/social/facebook/start?next=/home");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(to.searchParams.get("scope")).toBe("email public_profile");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/social/facebook/callback",
    );
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
