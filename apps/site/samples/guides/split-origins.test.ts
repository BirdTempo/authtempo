import { describe, expect, it } from "vitest";
import { call, harness, linkIn } from "../support/harness.ts";
import { createSplitOriginsAuth } from "./split-origins.ts";

const APP = "https://app.example.net";

describe("run the app on another origin", () => {
  it("answers the app's preflight with credentialed CORS, and refuses another origin", async () => {
    const auth = createSplitOriginsAuth(harness());
    const ok = await call(auth, "OPTIONS" as "GET", "/auth/session", undefined, { origin: APP });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(APP);
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    const other = await call(
      auth,
      "POST",
      "/auth/magic-link/request",
      { email: "a@example.com" },
      {
        origin: "https://evil.example",
      },
    );
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: "origin_not_trusted" });
  });

  it("lands the sign-in on the app origin with a SameSite=None cookie", async () => {
    const h = harness();
    const auth = createSplitOriginsAuth(h);
    await call(
      auth,
      "POST",
      "/auth/magic-link/request",
      { email: "ada@example.com", next: "/home" },
      { origin: APP },
    );
    const token = linkIn(h, "ada@example.com").searchParams.get("token") ?? "";
    const res = await auth.handle(
      new Request("https://api.example.com/auth/magic-link/verify", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://api.example.com",
        },
        body: new URLSearchParams({ token }).toString(),
      }),
    );
    expect(res.headers.get("location")).toBe(`${APP}/home`);
    expect(res.headers.get("set-cookie")).toContain("SameSite=None");
  });
});
