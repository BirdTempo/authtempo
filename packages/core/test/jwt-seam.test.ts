import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createJoseJwtSeam } from "../src/seams/jwt.js";

const JWKS_URL = "https://issuer.example/.well-known/jwks.json";
const NOW = new Date("2026-01-01T00:00:00.000Z");

async function issuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  let fetches = 0;
  const fetchFn: typeof fetch = async (input) => {
    fetches++;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== JWKS_URL) return new Response("not found", { status: 404 });
    return Response.json({ keys: [jwk] });
  };
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300)
      .sign(privateKey);
  return { sign, fetchFn, fetches: () => fetches };
}

describe("jose jwt seam", () => {
  it("verifies an ID token against a JWKS fetched once through the injected fetch", async () => {
    const iss = await issuer();
    const seam = createJoseJwtSeam(iss.fetchFn);
    const token = await iss.sign({
      iss: "https://issuer.example",
      aud: "client-1",
      sub: "u1",
      nonce: "n",
    });
    const common = {
      jwksUrl: JWKS_URL,
      issuer: "https://issuer.example",
      audience: "client-1",
      now: NOW,
    };
    const claims = await seam.verifyIdToken({ token, ...common });
    expect(claims).toMatchObject({ sub: "u1", nonce: "n" });
    await seam.verifyIdToken({ token, ...common });
    expect(iss.fetches()).toBe(1);
  });

  it("accepts any issuer of a list", async () => {
    const iss = await issuer();
    const seam = createJoseJwtSeam(iss.fetchFn);
    const token = await iss.sign({ iss: "accounts.google.com", aud: "c", sub: "u1" });
    const claims = await seam.verifyIdToken({
      token,
      jwksUrl: JWKS_URL,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: "c",
      now: NOW,
    });
    expect(claims.sub).toBe("u1");
  });

  it("rejects a wrong audience, a wrong issuer, an expired token, and a bad signature", async () => {
    const iss = await issuer();
    const other = await issuer();
    const seam = createJoseJwtSeam(iss.fetchFn);
    const token = await iss.sign({ iss: "https://issuer.example", aud: "client-1", sub: "u1" });
    const base = {
      jwksUrl: JWKS_URL,
      issuer: "https://issuer.example",
      audience: "client-1",
      now: NOW,
    };
    await expect(seam.verifyIdToken({ token, ...base, audience: "client-2" })).rejects.toThrow();
    await expect(
      seam.verifyIdToken({ token, ...base, issuer: "https://evil.example" }),
    ).rejects.toThrow();
    await expect(
      seam.verifyIdToken({ token, ...base, now: new Date(NOW.getTime() + 301_000) }),
    ).rejects.toThrow();
    const forged = await other.sign({ iss: "https://issuer.example", aud: "client-1", sub: "u1" });
    await expect(seam.verifyIdToken({ token: forged, ...base })).rejects.toThrow();
  });

  it("signs an ES256 JWT with the key id in the header", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const seam = createJoseJwtSeam(fetch);
    const token = await seam.signES256({
      privateKeyPem: await exportPKCS8(privateKey),
      keyId: "ABC123",
      payload: {
        iss: "TEAM",
        sub: "com.example.app",
        aud: "https://appleid.apple.com",
        iat: 1,
        exp: 2_000_000_000,
      },
    });
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      issuer: "TEAM",
      audience: "https://appleid.apple.com",
    });
    expect(protectedHeader).toMatchObject({ alg: "ES256", kid: "ABC123" });
    expect(payload.sub).toBe("com.example.app");
  });
});
