import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALLBACK,
  call,
  challengeOf,
  lastLink,
  mailbox,
  newSandbox,
  newVerifier,
  ORIGIN,
  pick,
  rowsIn,
  SESSION_COOKIE,
  signInByLink,
  whoami,
} from "./helpers.js";

const EMAIL = "ada@example.com";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the guards of the demo", () => {
  it("counts the visitor from cf-connecting-ip and drops an x-demo-client-ip of the request", async () => {
    const jar = await newSandbox();
    // A visitor who sends the header to pass the per-IP limits of core.
    const ips = { "cf-connecting-ip": "203.0.113.7", "x-demo-client-ip": "198.51.100.66" };
    await call(jar, "POST", "/auth/magic-link/request", { email: EMAIL }, ips);
    const token = (await lastLink(jar, EMAIL)).searchParams.get("token") ?? "";
    await call(jar, "POST", "/auth/magic-link/verify", new URLSearchParams({ token }), ips);
    expect(await rowsIn(jar, "SELECT ip FROM ta_session")).toEqual([{ ip: "203.0.113.7" }]);
  });

  it("keeps the mail of one sandbox out of the mailbox of another", async () => {
    const a = await newSandbox();
    const b = await newSandbox();
    await signInByLink(a, EMAIL);
    expect((await mailbox(a)).map((m) => m.to)).toEqual([EMAIL]);
    expect(await mailbox(b)).toEqual([]);
  });

  it("signs in with a code of the demo provider only in the sandbox that made it", async () => {
    const home = await newSandbox();
    const start = await call(home, "GET", "/auth/social/demo/start");
    const authorize = new URL(start.headers.get("location") ?? "");
    // The code comes from the provider of another sandbox, for the state of this one.
    const elsewhere = await newSandbox();
    const back = await pick(elsewhere, `${authorize.pathname}${authorize.search}`, "ada");
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    const done = await call(home, "GET", `${back.pathname}${back.search}`);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toMatch(new RegExp(`^${ORIGIN}/\\?auth_error=`));
    expect(home.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await whoami(home)).toBeNull();
  });

  it("sends a code of the demo provider to the callback of the demo only", async () => {
    const jar = await newSandbox();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "demo-provider-client",
      redirect_uri: "https://evil.example/auth/social/demo/callback",
      state: "s",
      code_challenge: await challengeOf(newVerifier()),
      code_challenge_method: "S256",
    });
    const page = await call(jar, "GET", `/provider/authorize?${q}`);
    expect(page.status).toBe(400);
    const post = await call(
      jar,
      "POST",
      `/provider/authorize?${q}`,
      new URLSearchParams({ identity: "ada" }),
    );
    expect(post.status).toBe(400);
    expect(await rowsIn(jar, "SELECT code FROM demo_provider_code")).toEqual([]);
  });

  it("sends no mail and no provider call out of the Worker", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no network"));
    const jar = await newSandbox();
    await signInByLink(jar, EMAIL);
    const start = await call(jar, "GET", "/auth/social/demo/start");
    const authorize = new URL(start.headers.get("location") ?? "");
    const back = await pick(jar, `${authorize.pathname}${authorize.search}`, "grace");
    const done = await call(jar, "GET", `${back.pathname}${back.search}`);
    expect(done.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(await whoami(jar)).toMatchObject({ email: "grace@example.com" });
    expect(spy).not.toHaveBeenCalled();
  });
});
