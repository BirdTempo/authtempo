import { createClient } from "@authtempo/client";
import { describe, expect, it } from "vitest";
import { API, call, codeIn, harness, lastMailTo, linkIn, signIn } from "../support/harness.ts";
import { createAccountAuth } from "./account-settings.ts";
import { deleteAccount } from "./account-settings-client.ts";

/** A clock that the test moves. */
function clock() {
  let now = Date.now();
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

const HOUR = 3_600_000;

describe("account settings", () => {
  it("lists the sessions, and ends the others", async () => {
    const h = harness();
    const auth = createAccountAuth(h);
    const phone = await signIn(auth, h, "ada@example.com");
    await signIn(auth, h, "ada@example.com");
    const list = (await (
      await call(auth, "GET", "/auth/sessions", undefined, { cookie: phone })
    ).json()) as { sessions: { current: boolean }[] };
    expect(list.sessions.map((s) => s.current).sort()).toEqual([false, true]);
    const ended = await call(auth, "POST", "/auth/sessions/revoke-others", {}, { cookie: phone });
    expect(await ended.json()).toEqual({ ended: 1 });
  });

  it("changes the address by a link to the new address, and tells the old one", async () => {
    const h = harness();
    const auth = createAccountAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const asked = await call(
      auth,
      "POST",
      "/auth/user/change-email",
      { newEmail: "ada@new.example.com" },
      { cookie: ada },
    );
    expect(await asked.json()).toEqual({ sent: true });
    const token = linkIn(h, "ada@new.example.com").searchParams.get("token");
    const moved = await call(auth, "POST", "/auth/user/change-email/confirm", { token });
    expect(((await moved.json()) as { user: { email: string } }).user.email).toBe(
      "ada@new.example.com",
    );
    expect(lastMailTo(h, "ada@example.com").text).toContain(
      "The new address is ada@new.example.com.",
    );
  });

  it("asks a stale session to prove it again, and the same session deletes the account", async () => {
    const h = harness();
    const time = clock();
    const auth = createAccountAuth({ ...h, clock: time });
    const cookie = await signIn(auth, h, "ada@example.com");
    // Past the fresh window of one hour. The session itself lives on.
    time.advance(2 * HOUR);
    const token = cookie.split("=")[1] ?? "";
    const sent: string[] = [];
    const client = createClient({
      baseURL: API,
      credentials: "omit",
      token: () => token,
      broadcast: false,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const res = await auth.handle(req);
        sent.push(`${new URL(req.url).pathname} ${res.status}`);
        return res;
      }) as typeof fetch,
    });
    const r = await deleteAccount(client, async () => codeIn(h, "ada@example.com"));
    expect(r).toEqual({ ok: true, value: { ok: true } });
    // The refusal, the code, the proof, and the delete once more.
    expect(sent).toEqual([
      "/auth/user/delete 403",
      "/auth/reauth/email 200",
      "/auth/reauth 200",
      "/auth/user/delete 200",
    ]);
    expect(lastMailTo(h, "ada@example.com").text).toContain("Your account was deleted.");
    expect(await call(auth, "GET", "/auth/session", undefined, { cookie })).toMatchObject({
      status: 401,
    });
  });
});
