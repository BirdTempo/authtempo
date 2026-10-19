import { describe, expect, it } from "vitest";
import { call, newSandbox, sameSandbox, signInByLink, whoami } from "./helpers.js";

const EMAIL = "ada@example.com";

describe("account delete", () => {
  it("deletes the account of a fresh session, and a new sign-in makes a new user", async () => {
    const jar = await newSandbox();
    await signInByLink(jar, EMAIL);
    const before = await whoami(jar);
    const deleted = await call(jar, "POST", "/auth/user/delete", {});
    expect(deleted.status).toBe(200);
    expect(await whoami(jar)).toBeNull();

    const again = sameSandbox(jar);
    await signInByLink(again, EMAIL);
    const after = await whoami(again);
    expect(after?.email).toBe(EMAIL);
    expect(after?.id).not.toBe(before?.id);
  });
});
