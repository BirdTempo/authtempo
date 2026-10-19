import { describe, expect, it } from "vitest";
import { call, newSandbox, sameSandbox, signInByLink, whoami } from "./helpers.js";

const EMAIL = "ada@example.com";

describe("account", () => {
  it("lists the sessions, changes the name, and ends the other sessions", async () => {
    const laptop = await newSandbox();
    await signInByLink(laptop, EMAIL);
    const phone = sameSandbox(laptop);
    await signInByLink(phone, EMAIL);

    const list = await call(laptop, "GET", "/auth/sessions");
    expect(list.status).toBe(200);
    expect(((await list.json()) as { sessions: unknown[] }).sessions).toHaveLength(2);

    const update = await call(laptop, "POST", "/auth/user/update", { name: "Ada Lovelace" });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ user: { name: "Ada Lovelace" } });

    const ended = await call(laptop, "POST", "/auth/sessions/revoke-others", {});
    expect(ended.status).toBe(200);
    expect(await ended.json()).toEqual({ ended: 1 });
    expect(await whoami(phone)).toBeNull();
    expect(await whoami(laptop)).toMatchObject({ email: EMAIL });
  });
});
