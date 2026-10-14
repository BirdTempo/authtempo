import { createAuth, type MailMessage } from "@authtempo/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The lazy timer of plan 11c (jwtMint.rotateEvery) on the real Postgres
// adapter, through core's built output: eight signatures on four
// connections pass the interval together. The retire matches the old row
// by id and slot, and the unique index on slot keeps one new key, so every
// token carries the one new kid.

const DAY = 86_400_000;
let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/** The kid of a compact JWS, from its header. */
function kidOf(token: string): string {
  const head = (token.split(".")[0] ?? "").replace(/-/g, "+").replace(/_/g, "/");
  return (JSON.parse(atob(head)) as { kid: string }).kid;
}

it("rotates once when eight signatures pass the interval together (plan 11c)", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const sent: MailMessage[] = [];
  const auth = createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: ["https://app.example.com"],
    storage: createPostgresAdapter(db.sql),
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    clock: { now: () => now },
    jwtMint: { rotateEvery: 7 },
  });
  const otp = auth.api.emailOtp;
  const jwt = auth.api.jwt;
  if (!otp || !jwt) throw new Error("emailOtp or jwtMint is off");
  const email = "burst@example.com";
  await otp.request({ email, ip: null });
  const code = /\b(\d{6})\b/.exec(sent[0]?.text ?? "")?.[1] ?? "";
  const signedIn = await otp.verify({ email, code, ip: null, userAgent: null });
  if (!signedIn.ok) throw new Error(signedIn.code);
  const input = { userId: signedIn.value.user.id, sessionId: signedIn.value.session.id };
  const first = await jwt.mint(input);
  if (!first.ok) throw new Error(first.code);

  now = new Date(now.getTime() + 7 * DAY);
  const minted = await Promise.all(Array.from({ length: 8 }, () => jwt.mint(input)));
  const tokens = minted.map((m) => {
    if (!m.ok) throw new Error(m.code);
    return m.value.token;
  });
  const signedWith = new Set(tokens.map(kidOf));
  expect(signedWith.size).toBe(1);
  expect(signedWith.has(kidOf(first.value.token))).toBe(false);

  const rows = await db.sql<{ id: string; slot: string | null; retired_at: Date | null }[]>`
    SELECT id, slot, retired_at FROM ta_jwk ORDER BY created_at, id`;
  expect(rows).toHaveLength(2);
  expect(rows[0]?.id).toBe(kidOf(first.value.token));
  expect(rows[0]?.slot).toBeNull();
  expect(rows[0]?.retired_at).not.toBeNull();
  expect(rows[1]?.slot).toBe("signing");
  for (const t of tokens) expect(await jwt.verify(t)).not.toBeNull();
});
