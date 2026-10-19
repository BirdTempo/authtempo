import { describe, expect, it } from "vitest";
import { call, newSandbox, sameSandbox, signInByLink, whoami } from "./helpers.js";

const EMAIL = "script-owner@example.com";

describe("API tokens", () => {
  it("creates a token, calls /whoami with it, and revokes it", async () => {
    const jar = await newSandbox();
    await signInByLink(jar, EMAIL);
    const created = await call(jar, "POST", "/auth/tokens", { name: "deploy script" });
    expect(created.status).toBe(200);
    const { token, apiToken } = (await created.json()) as {
      token: string;
      apiToken: { id: string };
    };
    expect(token).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);

    // The token alone, with the sandbox cookie and no session cookie.
    const script = sameSandbox(jar);
    const bearer = { authorization: `Bearer ${token}` };
    expect(await whoami(script, bearer)).toMatchObject({ kind: "token", email: EMAIL });

    const revoked = await call(jar, "POST", "/auth/tokens/revoke", { id: apiToken.id });
    expect(await revoked.json()).toEqual({ ok: true });
    expect(await whoami(script, bearer)).toBeNull();
  });
});
