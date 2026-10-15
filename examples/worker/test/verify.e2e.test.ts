import { SELF } from "cloudflare:test";
import { DEFAULT_COOKIE_NAME } from "@authtempo/core/credentials";
import { createVerifier } from "@authtempo/verify";
import { expect, it } from "vitest";
import { BASE, signIn } from "./helpers.js";

const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  SELF.fetch(input, init)) as typeof globalThis.fetch;

it("verifies a session JWT at /notes on Workers with the live check, and refuses it after the sign-out", async () => {
  const client = await signIn("notes@example.com");
  const minted = await client.jwt.token();
  if (!minted.ok) throw new Error(minted.code);
  const notes = (bearer?: string) =>
    SELF.fetch(`${BASE}/notes`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
  const ok = await notes(minted.value.token);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ owner: "notes@example.com" });
  const none = await notes();
  expect(none.status).toBe(401);
  expect(none.headers.get("www-authenticate")).toBe("Bearer");
  // A Basic header is no bearer: the plain challenge, as with no header.
  const basic = await SELF.fetch(`${BASE}/notes`, {
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });
  expect(basic.status).toBe(401);
  expect(basic.headers.get("www-authenticate")).toBe("Bearer");
  // The verifier reads the bearer only: a session cookie beside a refused bearer
  // does not hide the refusal, so the answer still names invalid_token.
  const withCookie = await SELF.fetch(`${BASE}/notes`, {
    headers: { cookie: `${DEFAULT_COOKIE_NAME}=ts_x`, authorization: "Bearer ts_refused" },
  });
  expect(withCookie.status).toBe(401);
  expect(withCookie.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  await client.signOut();
  const refused = await notes(minted.value.token);
  expect(refused.status).toBe(401);
  // A request that held a refused token gets error="invalid_token" (RFC 6750 section 3.1).
  expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
});

it("answers 429 at /notes when the auth app limits the live checks of one session", async () => {
  const client = await signIn("busy@example.com");
  const minted = await client.jwt.token();
  if (!minted.ok) throw new Error(minted.code);
  let res: Response | null = null;
  // Core allows 120 live checks a minute for one session (LIVE_PER_SESSION).
  for (let i = 0; i < 130; i++) {
    res = await SELF.fetch(`${BASE}/notes`, {
      headers: { authorization: `Bearer ${minted.value.token}` },
    });
    if (res.status !== 200) break;
  }
  expect(res?.status).toBe(429);
  expect(await res?.json()).toEqual({ error: "rate_limited" });
});

it("verifies the session JWT in the Workers runtime with a verifier of its own, and answers null to a changed token", async () => {
  const client = await signIn("runtime@example.com");
  const minted = await client.jwt.token();
  if (!minted.ok) throw new Error(minted.code);
  const verifier = createVerifier({ issuer: `${BASE}/auth`, audience: BASE, fetch });
  const r = await verifier.verifyRequest(
    new Request(`${BASE}/x`, { headers: { authorization: `Bearer ${minted.value.token}` } }),
  );
  expect(r.ok && r.value?.kind === "session-jwt" && r.value.email).toBe("runtime@example.com");
  const t = minted.value.token;
  const changed = `${t.slice(0, -2)}${t.endsWith("AA") ? "BB" : "AA"}`;
  expect(
    await verifier.verifyRequest(
      new Request(`${BASE}/x`, { headers: { authorization: `Bearer ${changed}` } }),
    ),
  ).toEqual({ ok: true, value: null });
});
