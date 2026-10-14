import type { Auth } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { API, APP, harness, linkIn } from "../support/harness.ts";
import { askForLink, createAppClient, signOut, welcome } from "./first-sign-in.ts";
import { createApiAuth } from "./first-sign-in-api.ts";

/** A browser on APP: it sends its Origin, keeps the API's session cookie, and sends it back. */
function browser(auth: Auth): typeof fetch {
  let cookie = "";
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set("origin", APP);
    if (cookie) headers.set("cookie", cookie);
    const body = req.method === "GET" ? null : await req.text();
    const res = await auth.handle(new Request(req.url, { method: req.method, headers, body }));
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0] ?? "";
      if (pair.startsWith("__Host-tempo_session="))
        cookie = pair === "__Host-tempo_session=" ? "" : pair;
    }
    return res;
  }) as typeof fetch;
}

describe("your first sign-in from a web app", () => {
  it("signs in by magic link, shows the address, and signs out", async () => {
    const h = harness();
    const auth = createApiAuth(h);
    const b = browser(auth);
    const client = createAppClient(b);
    expect(await welcome(client)).toBe("Not signed in.");
    expect(await askForLink(client, "ada@example.com")).toBe(
      "Check your mail for the sign-in link.",
    );

    // The person opens the link, and the confirm page posts its form.
    const link = linkIn(h, "ada@example.com");
    expect(`${link.origin}${link.pathname}`).toBe(`${API}/auth/magic-link/verify`);
    const press = await b(`${API}/auth/magic-link/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: link.searchParams.get("token") ?? "" }).toString(),
      redirect: "manual",
    });
    expect(press.status).toBe(302);
    expect(press.headers.get("location")).toBe(`${APP}/welcome`);

    expect(await welcome(client)).toBe("Signed in as ada@example.com.");
    expect(await signOut(client)).toBe(true);
    expect(await welcome(client)).toBe("Not signed in.");
  });
});
