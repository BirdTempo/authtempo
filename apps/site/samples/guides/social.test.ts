import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createSocialAuth } from "./social.ts";

describe("sign in with Google and Apple", () => {
  it("sends the browser to Google with state, nonce, PKCE, and a binding cookie", async () => {
    const auth = createSocialAuth(harness());
    const res = await call(auth, "GET", "/auth/social/google/start?next=/home");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(`${to.origin}${to.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/social/google/callback",
    );
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("state")).not.toBeNull();
    expect(to.searchParams.get("nonce")).not.toBeNull();
    const cookie =
      res.headers.getSetCookie().find((c) => c.startsWith("tempo_session_oauth=")) ?? "";
    expect(cookie).toContain("Path=/auth/social");
    expect(cookie).toContain("SameSite=None");
  });

  it("asks Apple for a form post to its own callback", async () => {
    const auth = createSocialAuth(harness());
    const res = await call(auth, "GET", "/auth/social/apple/start");
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin).toBe("https://appleid.apple.com");
    expect(to.searchParams.get("response_mode")).toBe("form_post");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/social/apple/callback",
    );
  });
});
