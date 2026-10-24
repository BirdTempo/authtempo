import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createGitlabAuth } from "./gitlab.ts";

describe("sign in with GitLab", () => {
  it("sends the person to the provider with the scope and a PKCE challenge", async () => {
    const auth = createGitlabAuth(harness());
    const res = await call(auth, "GET", "/auth/social/gitlab/start?next=/home");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://gitlab.example.org/oauth/authorize");
    expect(to.searchParams.get("scope")).toBe("read_user");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/social/gitlab/callback",
    );
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  });
});
