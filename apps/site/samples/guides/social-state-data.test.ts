import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createStateDataAuth, startUrl } from "./social-state-data.ts";

describe("carry app data through a social sign-in", () => {
  it("starts the flow with the payload and keeps it out of the provider URL", async () => {
    const auth = createStateDataAuth(harness());
    const res = await call(auth, "GET", startUrl("/welcome", { plan: "pro" }));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin).toBe("https://accounts.google.com");
    expect(to.searchParams.has("data")).toBe(false);
  });

  it("refuses a payload over the bound and a list", async () => {
    const auth = createStateDataAuth(harness());
    for (const path of [
      startUrl("/welcome", { note: "x".repeat(600) }),
      "/auth/social/google/start?data=WzFd",
    ]) {
      const res = await call(auth, "GET", path);
      expect(new URL(res.headers.get("location") ?? "").searchParams.get("auth_error")).toBe(
        "invalid_body",
      );
    }
  });
});
