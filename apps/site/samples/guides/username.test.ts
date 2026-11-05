import { describe, expect, it } from "vitest";
import {
  call,
  callSettled,
  harness,
  linkIn,
  proofCookieOf,
  sessionCookieOf,
} from "../support/harness.ts";
import { createUsernameAuth } from "./username.ts";

describe("sign in with a username", () => {
  it("sets a username after the confirm, and signs in with it", async () => {
    const h = harness();
    const auth = createUsernameAuth(h);
    const password = "correct horse battery";
    const up = await callSettled(auth, "POST", "/auth/password/sign-up", {
      email: "ada@example.com",
      password,
    });
    // The confirm link proves the address and opens a fresh session. The
    // browser of the sign-up sends its proof cookie, so the password stays.
    const token = linkIn(h, "ada@example.com").searchParams.get("token") ?? "";
    const confirmed = await call(
      auth,
      "POST",
      "/auth/password/verify",
      { token },
      { cookie: proofCookieOf(up) },
    );
    const cookie = sessionCookieOf(confirmed);

    const free = await call(auth, "GET", "/auth/username/available?username=Ada_L");
    expect(await free.json()).toEqual({ available: true });
    const set = await call(auth, "POST", "/auth/user/username", { username: "Ada_L" }, { cookie });
    expect(await set.json()).toEqual({ username: "ada_l", displayUsername: "Ada_L" });

    // The sign-in reads the stored form, so the case does not matter.
    const res = await call(auth, "POST", "/auth/password/sign-in", { username: "ADA_L", password });
    expect(res.status).toBe(200);
  });

  it("answers invalid_credentials for an unknown name, as for a wrong password", async () => {
    const auth = createUsernameAuth(harness());
    const res = await call(auth, "POST", "/auth/password/sign-in", {
      username: "nobody",
      password: "correct horse battery",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials" });
  });

  it("refuses a reserved name", async () => {
    const auth = createUsernameAuth(harness());
    const res = await call(auth, "GET", "/auth/username/available?username=staff");
    expect(await res.json()).toEqual({ error: "username_invalid" });
  });
});
