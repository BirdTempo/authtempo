import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { BASE } from "./helpers";

// The secret whose SHA-256 hex is OPERATOR_SECRET_HASH in vitest.config.ts (plan 11c).
const OPERATOR_SECRET = "authtempo-example-operator-secret-0123456789";

async function keyIds(): Promise<string[]> {
  const res = await SELF.fetch(`${BASE}/auth/jwks`);
  return ((await res.json()) as { keys: { kid: string }[] }).keys.map((k) => k.kid);
}

it("rotates the signing key on D1 through the operator route, and the JWKS lists the new key first (plan 11c)", async () => {
  const before = await keyIds();
  const post = (secret: string) =>
    SELF.fetch(`${BASE}/auth/operator/keys/rotate`, {
      method: "POST",
      headers: { authorization: `Operator ${secret}` },
    });
  expect((await post("wrong-secret-wrong-secret-wrong-secret-0000")).status).toBe(401);
  const res = await post(OPERATOR_SECRET);
  expect(res.status).toBe(200);
  const { kid } = (await res.json()) as { kid: string };
  const after = await keyIds();
  expect(after[0]).toBe(kid);
  expect(after).toContain(before[0]);
});
