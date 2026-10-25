import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createDiscordAuth } from "./discord.ts";

describe("sign in with Discord", () => {
  it("sends the person to the provider with the scope and a PKCE challenge", async () => {
    const auth = createDiscordAuth(harness());
    const res = await call(auth, "GET", "/auth/social/discord/start?next=/home");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(to.searchParams.get("scope")).toBe("identify email");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/social/discord/callback",
    );
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
