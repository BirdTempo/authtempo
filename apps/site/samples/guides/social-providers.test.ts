import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createProvidersAuth } from "./social-providers.ts";

async function startOf(name: string) {
  const res = await call(createProvidersAuth(harness()), "GET", `/auth/social/${name}/start`);
  return new URL(res.headers.get("location") ?? "");
}

describe("sign in with GitHub and any provider", () => {
  it("sends GitHub its scope and no nonce", async () => {
    const to = await startOf("github");
    expect(`${to.origin}${to.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("scope")).toBe("read:user user:email");
    expect(to.searchParams.get("nonce")).toBeNull();
  });

  it("sends an OpenID Connect entry a nonce, and an OAuth 2.0 entry none", async () => {
    expect((await startOf("microsoft")).searchParams.get("nonce")).not.toBeNull();
    const discord = await startOf("discord");
    expect(`${discord.origin}${discord.pathname}`).toBe("https://discord.com/oauth2/authorize");
    expect(discord.searchParams.get("nonce")).toBeNull();
    expect(discord.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/social/discord/callback",
    );
  });
});
