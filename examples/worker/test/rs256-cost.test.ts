import { createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { it } from "vitest";

/**
 * The cost of RS256 in workerd (plan 12e Task 2 Step 7, an open point).
 * Not in the default run: the `cost` config runs it by hand,
 * `vitest run --config vitest.cost.config.ts`. It prints one line and asserts nothing.
 * `generate` is one `api.jwt.rotate()`: an RSA 2048 key, its seal, and its row.
 * `sign100` is 100 `api.jwt.mint` calls: each opens the sealed key and signs once.
 * The numbers are wall time in the local runtime, not the CPU time of a deployed Worker.
 */
it("prints the cost of one RS256 key and 100 RS256 signatures", async () => {
  const mail: MailMessage[] = [];
  const auth = createAuth({
    baseURL: "https://example.test",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    jwtMint: { alg: "RS256" },
  });
  const jwt = auth.api.jwt;
  if (!jwt) throw new Error("jwtMint is off");
  const sent = await auth.api.requestMagicLink({ email: "cost@example.com", ip: null });
  if (!sent.ok) throw new Error(sent.code);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? "")?.[1] ?? "";
  const v = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!v.ok || "twoFactor" in v.value) throw new Error("no session");
  const current = await auth.session(
    new Request("https://example.test/auth/session", {
      headers: { authorization: `Bearer ${v.value.token}` },
    }),
  );
  if (!current) throw new Error("no session");
  const input = { userId: current.user.id, sessionId: current.session.id };
  const t0 = performance.now();
  await jwt.rotate();
  const t1 = performance.now();
  for (let i = 0; i < 100; i++) {
    const r = await jwt.mint(input);
    if (!r.ok) throw new Error(r.code);
  }
  const t2 = performance.now();
  console.log(`rs256-cost: generate=${(t1 - t0).toFixed(1)} sign100=${(t2 - t1).toFixed(1)}`);
});
