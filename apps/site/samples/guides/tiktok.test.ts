import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createTiktokAuth } from "./tiktok.ts";

describe("sign in with TikTok", () => {
  it("sends the person to TikTok with the client key", async () => {
    const auth = createTiktokAuth(harness());
    const res = await call(auth, "GET", "/auth/social/tiktok/start?next=/home");
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(to.searchParams.get("client_key")).toBe("tiktok-client-key");
    expect(to.searchParams.get("scope")).toBe("user.info.basic");
  });
});
