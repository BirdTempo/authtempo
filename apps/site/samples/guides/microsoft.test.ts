import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createMicrosoftAuth } from "./microsoft.ts";

describe("sign in with Microsoft Entra ID", () => {
  it("sends the person to the provider with the scope and a PKCE challenge", async () => {
    const auth = createMicrosoftAuth(harness());
    const res = await call(auth, "GET", "/auth/social/microsoft/start?next=/home");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    );
    expect(to.searchParams.get("scope")).toBe("openid profile email");
    expect(to.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/auth/social/microsoft/callback",
    );
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("client_id")).toBe("00000000-0000-4000-8000-000000000001");
  });
});
