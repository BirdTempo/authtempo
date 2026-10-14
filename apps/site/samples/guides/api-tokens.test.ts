import { describe, expect, it } from "vitest";
import { API, call, harness, signIn } from "../support/harness.ts";
import { createTokensAuth, whoami } from "./api-tokens.ts";
import { createCliClient } from "./api-tokens-cli.ts";

describe("give a script an API token", () => {
  it("creates a token from a session, and the script reads who it is", async () => {
    const h = harness();
    const auth = createTokensAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const created = await call(
      auth,
      "POST",
      "/auth/tokens",
      { name: "ci", expiresInDays: 30 },
      { cookie: ada },
    );
    const { token, apiToken } = (await created.json()) as {
      token: string;
      apiToken: { hint: string };
    };
    expect(token.startsWith("tk_")).toBe(true);
    expect(apiToken.hint).toBe(token.slice(3, 11));

    const me = await whoami(
      auth,
      new Request(`${API}/whoami`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(await me.json()).toEqual({ kind: "token", email: "ada@example.com" });

    const cli = createCliClient(token, ((input: RequestInfo | URL, init?: RequestInit) =>
      auth.handle(new Request(input, init))) as typeof fetch);
    const current = await cli.tokens.current();
    expect(current.ok && current.value.user.email).toBe("ada@example.com");
  });

  it("refuses a token where core needs a session, so a token cannot mint a token", async () => {
    const h = harness();
    const auth = createTokensAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const { token } = (await (
      await call(auth, "POST", "/auth/tokens", { name: "ci" }, { cookie: ada })
    ).json()) as {
      token: string;
    };
    const again = await call(
      auth,
      "POST",
      "/auth/tokens",
      { name: "two" },
      { authorization: `Bearer ${token}` },
    );
    expect(again.status).toBe(401);
  });
});
