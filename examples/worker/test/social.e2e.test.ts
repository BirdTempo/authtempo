import { env, SELF } from "cloudflare:test";
import { createJoseJwtSeam } from "@tempo-auth/core";
import { expect, it } from "vitest";

const BASE = "https://example.test";

it("starts a Google sign-in on D1: one oauth-state row, a redirect, and a binding cookie", async () => {
  const res = await SELF.fetch(`${BASE}/auth/social/google/start?next=%2Fme`, {
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin).toBe("https://accounts.google.com");
  expect(location.searchParams.get("client_id")).toBe("example-client");
  expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/social/google/callback`);
  expect(res.headers.get("set-cookie")).toMatch(/^tempo_session_oauth=.*SameSite=None$/);
  const rows = await env.DB.prepare(
    "SELECT count(*) AS n FROM ta_verification WHERE purpose = 'oauth-state' AND consumed_at IS NULL",
  ).first<{ n: number }>();
  expect(rows?.n).toBe(1);
});

/** PEM from a DER buffer, 64 columns, the shape `importPKCS8` reads. */
function pem(label: string, der: ArrayBuffer): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

it("jose signs ES256 and verifies against a JWKS on the Workers runtime", async () => {
  // The overload returns CryptoKey | CryptoKeyPair; an ECDSA key pair is a CryptoKeyPair.
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateKeyPem = pem(
    "PRIVATE KEY",
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwksUrl = "https://issuer.example/keys";
  const fetchFn: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== jwksUrl) return new Response("not found", { status: 404 });
    return Response.json({ keys: [{ ...jwk, kid: "k1", use: "sig", alg: "ES256" }] });
  };
  const seam = createJoseJwtSeam(fetchFn);
  const now = new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const token = await seam.signES256({
    privateKeyPem,
    keyId: "k1",
    payload: {
      iss: "https://issuer.example",
      aud: "client",
      sub: "u1",
      nonce: "n",
      iat,
      exp: iat + 300,
    },
  });
  const claims = await seam.verifyIdToken({
    token,
    jwksUrl,
    issuer: "https://issuer.example",
    audience: "client",
    now,
  });
  expect(claims).toMatchObject({ sub: "u1", nonce: "n" });
  await expect(
    seam.verifyIdToken({
      token,
      jwksUrl,
      issuer: "https://issuer.example",
      audience: "other",
      now,
    }),
  ).rejects.toThrow();
});
