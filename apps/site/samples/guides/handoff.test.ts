import type { HandoffOpener } from "@authtempo/handoff";
import { describe, expect, it } from "vitest";
import { API, call, harness, linkIn, sessionCookieOf } from "../support/harness.ts";
import { createHandoffAuth } from "./handoff.ts";
import { createAppHandoff } from "./handoff-app.ts";

describe("sign in from a native or desktop app", () => {
  it("signs in through the system browser and redeems the code for a bearer token", async () => {
    const h = harness();
    const auth = createHandoffAuth(h);
    // The system browser: the person signs in by magic link and presses Continue.
    const opener: HandoffOpener = {
      async open(url) {
        const page = await (await auth.handle(new Request(url))).text();
        const id = /hs_[A-Za-z0-9_-]{43}/.exec(page)?.[0] ?? "";
        const next = `/auth/handoff/continue?h=${id}`;
        await call(auth, "POST", "/auth/magic-link/request", { email: "ada@example.com", next });
        const token = linkIn(h, "ada@example.com").searchParams.get("token") ?? "";
        const verify = await auth.handle(
          new Request(`${API}/auth/magic-link/verify`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", origin: API },
            body: new URLSearchParams({ token }).toString(),
          }),
        );
        const cookie = sessionCookieOf(verify);
        expect(verify.headers.get("location")).toBe(`${API}${next}`);
        const press = await auth.handle(
          new Request(`${API}/auth/handoff/continue`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", origin: API, cookie },
            body: new URLSearchParams({ h: id }).toString(),
          }),
        );
        return press.headers.get("location");
      },
    };
    const handoff = createAppHandoff(opener, ((input: RequestInfo | URL, init?: RequestInit) =>
      auth.handle(new Request(input, init))) as typeof fetch);
    const result = await handoff.signIn();
    expect(result.ok && result.value.token.startsWith("ts_")).toBe(true);
    expect(result.ok && result.value.user.email).toBe("ada@example.com");
  });

  it("refuses a redirect that no scheme of the config admits", async () => {
    const auth = createHandoffAuth(harness());
    const res = await call(
      auth,
      "GET",
      `/auth/handoff/start?challenge=${"a".repeat(43)}&redirect=evil://auth`,
    );
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });
});
