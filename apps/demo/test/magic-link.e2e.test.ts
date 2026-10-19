import { describe, expect, it } from "vitest";
import { call, lastLink, newSandbox, SESSION_COOKIE, whoami } from "./helpers.js";

const EMAIL = "ada@example.com";

describe("magic link", () => {
  it("requests a link, opens the confirm page, and signs in", async () => {
    const jar = await newSandbox();
    const sent = await call(jar, "POST", "/auth/magic-link/request", { email: EMAIL });
    expect(sent.status).toBe(200);
    const link = await lastLink(jar, EMAIL);
    expect(link.pathname).toBe("/auth/magic-link/verify");
    expect(link.searchParams.get("token")).toMatch(/^ml_/);

    // The confirm page changes nothing: no cookie.
    const page = await call(jar, "GET", `${link.pathname}${link.search}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(await page.text()).toContain(`<form method="post" action="/auth/magic-link/verify">`);
    expect(await whoami(jar)).toBeNull();

    const verify = await call(
      jar,
      "POST",
      "/auth/magic-link/verify",
      new URLSearchParams({ token: link.searchParams.get("token") ?? "" }),
    );
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toBe("https://demo.authtempo.com/");
    expect(jar.cookies.has(SESSION_COOKIE)).toBe(true);
    expect(await whoami(jar)).toMatchObject({ kind: "session", email: EMAIL });
  });
});
