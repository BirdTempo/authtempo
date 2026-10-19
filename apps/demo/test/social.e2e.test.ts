import { describe, expect, it } from "vitest";
import {
  call,
  codeFor,
  exchange,
  newSandbox,
  newVerifier,
  ORIGIN,
  pick,
  SESSION_COOKIE,
  sameSandbox,
  whoami,
} from "./helpers.js";

/** The three fixed identities of the demo provider: the button value and the address. */
const IDENTITIES = [
  ["ada", "ada@example.com"],
  ["grace", "grace@example.com"],
  ["alan", "alan@example.com"],
] as const;

describe("social sign-in through the demo provider", () => {
  it("signs in as each of the three identities through the demo provider", async () => {
    const first = await newSandbox();
    for (const [identity, email] of IDENTITIES) {
      const jar = sameSandbox(first);
      const start = await call(jar, "GET", "/auth/social/demo/start");
      expect(start.status).toBe(302);
      const authorize = new URL(start.headers.get("location") ?? "");
      expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ORIGIN}/provider/authorize`);
      const back = await pick(jar, `${authorize.pathname}${authorize.search}`, identity);
      const done = await call(jar, "GET", `${back.pathname}${back.search}`);
      expect(done.status).toBe(302);
      expect(done.headers.get("location")).toBe(`${ORIGIN}/`);
      expect(jar.cookies.has(SESSION_COOKIE)).toBe(true);
      expect(await whoami(jar)).toMatchObject({ kind: "session", email });
    }
  });

  it("refuses a spent code", async () => {
    const jar = await newSandbox();
    const verifier = newVerifier();
    const code = await codeFor(jar, verifier);
    const once = await exchange(jar, code, verifier);
    expect(once.status).toBe(200);
    expect(await once.json()).toMatchObject({ token_type: "bearer" });
    const twice = await exchange(jar, code, verifier);
    expect(twice.status).toBe(400);
    expect(await twice.json()).toEqual({ error: "invalid_grant" });
  });

  it("refuses a wrong verifier", async () => {
    const jar = await newSandbox();
    const code = await codeFor(jar, newVerifier());
    const res = await exchange(jar, code, newVerifier());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
  });
});
