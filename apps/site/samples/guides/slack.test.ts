import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createSlackAuth } from "./slack.ts";

describe("sign in with Slack", () => {
  it("sends the person to the provider with the scope and a PKCE challenge", async () => {
    const auth = createSlackAuth(harness());
    const res = await call(auth, "GET", "/auth/social/slack/start?next=/home");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://slack.com/openid/connect/authorize");
    expect(to.searchParams.get("scope")).toBe("openid profile email");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/social/slack/callback",
    );
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
