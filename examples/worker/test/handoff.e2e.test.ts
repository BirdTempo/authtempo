import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";

const BASE = "https://example.test";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

it("hands a magic link sign-in in the browser off to an app as a bearer token on D1", async () => {
  // The app makes a PKCE pair and opens the browser.
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const start = await SELF.fetch(
    `${BASE}/auth/handoff/start?challenge=${challenge}&redirect=${encodeURIComponent("example-app://auth")}`,
  );
  expect(start.status).toBe(200);
  const html = await start.text();
  const cont = /data-continue="([^"]+)"/.exec(html)?.[1] ?? "";
  expect(cont).toMatch(/^\/auth\/handoff\/continue\?h=hs_/);
  const csp = start.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("example-app:");

  // The person asks for a magic link from the page; its next is the continue path.
  const req = await SELF.fetch(`${BASE}/auth/magic-link/request`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "ada@example.com", next: cont }),
  });
  expect(req.status).toBe(200);
  const { link } = (await (await SELF.fetch(`${BASE}/__test/last-link`)).json()) as {
    link: string;
  };
  const token = new URL(link).searchParams.get("token") ?? "";
  const verify = await SELF.fetch(`${BASE}/auth/magic-link/verify`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ token }).toString(),
  });
  expect(verify.status).toBe(302);
  expect(verify.headers.get("location")).toBe(`${BASE}${cont}`);
  const cookie = verify.headers.get("set-cookie")?.split(";")[0] ?? "";

  // The browser follows to continue with the new cookie and lands on the app scheme.
  const next = await SELF.fetch(`${BASE}${cont}`, { redirect: "manual", headers: { cookie } });
  expect(next.status).toBe(302);
  const location = next.headers.get("location") ?? "";
  expect(location).toMatch(/^example-app:\/\/auth\?code=hc_/);
  const code = new URL(location).searchParams.get("code") ?? "";

  // The app redeems the code with its verifier and gets a bearer token.
  const redeem = await SELF.fetch(`${BASE}/auth/handoff/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  expect(redeem.status).toBe(200);
  const { token: bearer, user } = (await redeem.json()) as {
    token: string;
    user: { email: string };
  };
  expect(user.email).toBe("ada@example.com");
  const me = await SELF.fetch(`${BASE}/me`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(me.status).toBe(200);
  const spent = await env.DB.prepare(
    "SELECT count(*) AS n FROM ta_verification WHERE purpose = 'handoff-code' AND consumed_at IS NOT NULL",
  ).first<{ n: number }>();
  expect(spent?.n).toBe(2);
  const replay = await SELF.fetch(`${BASE}/auth/handoff/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  expect(replay.status).toBe(400);
});

it("answers a preflight from the trusted origin", async () => {
  const pre = await SELF.fetch(`${BASE}/auth/session`, {
    method: "OPTIONS",
    headers: { origin: BASE, "access-control-request-method": "GET" },
  });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe(BASE);
  expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
});
