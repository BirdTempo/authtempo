import { createAuth } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { API, harness, signIn } from "../support/harness.ts";
import { cliOAuthClient, registerCli } from "./third-party-app.ts";

describe("sign in from a third-party app", () => {
  it("registers a CLI, signs the person in with PKCE, and refreshes", async () => {
    const h = harness();
    const auth = createAuth({
      baseURL: API,
      trustedOrigins: [],
      secret: h.secret,
      storage: h.storage,
      mail: h.mail,
      oauth: { resources: [`${API}/mcp`], registration: { cimd: false } },
    });
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      auth.handle(new Request(input, init))) as typeof globalThis.fetch;
    const reg = await registerCli(fetch);
    if (!reg.ok) throw new Error(reg.code);
    const oauth = cliOAuthClient(reg.value.clientId, fetch);
    const url = await oauth.authorizeURL();
    if (!url.ok) throw new Error(url.code);
    // The person's browser: signed in, it opens the URL and allows the CLI.
    const cookie = await signIn(auth, h, "ada@example.com");
    const page = await auth.handle(new Request(url.value, { headers: { cookie } }));
    const id = /name="request_id" value="(oq_[A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1];
    const allowed = await auth.handle(
      new Request(`${API}/auth/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: API, cookie },
        body: new URLSearchParams({ request_id: id ?? "", decision: "allow" }).toString(),
      }),
    );
    const tokens = await oauth.handleRedirect(allowed.headers.get("location") ?? "");
    if (!tokens.ok) throw new Error(tokens.code);
    expect(tokens.value.scopes).toEqual(["openid", "offline_access"]);
    const next = await oauth.refresh(tokens.value.refreshToken ?? "");
    expect(next.ok).toBe(true);
  });
});
