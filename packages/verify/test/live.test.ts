import { expect, it } from "vitest";
import { createVerifier } from "../src/index.js";

// A real auth app. The test runs only when AUTHTEMPO_LIVE_ISSUER holds the issuer of a running auth app.
// The issuer is `baseURL + basePath`. The evidence of a build does not count this test.
// It proves the real fetch path: the key set answers through `redirect: "manual"` and the owned deadline.
// So a token of an unknown key answers null and not a failure.
const issuer = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
  ?.env.AUTHTEMPO_LIVE_ISSUER;

it.runIf(issuer !== undefined && issuer !== "")(
  "reads the key set of a real auth app",
  async () => {
    const verifier = createVerifier({ issuer: issuer ?? "", audience: "https://live.example.com" });
    const part = (v: object) =>
      btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const token = `${part({ alg: "EdDSA", kid: "no-such-kid", typ: "JWT" })}.${part({ sub: "x" })}.AAAA`;
    const r = await verifier.verifyRequest(
      new Request("https://live.example.com/", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(r).toEqual({ ok: true, value: null });
  },
);
