import { createAuth, type MailMessage } from "@tempo-auth/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The email code count (plan 9e) is a compare-and-set on `updatedAt`. The
// memory burst test and the D1 e2e prove it there. This test proves it on
// the real Postgres adapter, through core's built output: parallel wrong
// codes on separate connections count exactly `maxAttempts` and spend the row.

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

it("counts exactly maxAttempts of eight parallel wrong codes on Postgres and spends the row (plan 9e, I-1)", async () => {
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
  });
  const otp = auth.api.emailOtp;
  if (!otp) throw new Error("emailOtp is off");
  const email = "burst@example.com";
  expect(await otp.request({ email, ip: null })).toEqual({ ok: true, value: { sent: true } });
  const code = /\b(\d{6})\b/.exec(sent[0]?.text ?? "")?.[1];
  if (!code) throw new Error("no code mailed");
  const wrong = code === "000000" ? "111111" : "000000";
  const answers = await Promise.all(
    Array.from({ length: 8 }, () => otp.verify({ email, code: wrong, ip: null, userAgent: null })),
  );
  expect(answers.map((a) => (a.ok ? "ok" : a.code)).sort()).toEqual([
    "invalid_code",
    "invalid_code",
    "invalid_code",
    "invalid_code",
    "too_many_attempts",
    "too_many_attempts",
    "too_many_attempts",
    "too_many_attempts",
  ]);
  const rows = await db.sql<{ data: unknown; consumed_at: Date | null }[]>`
    SELECT data, consumed_at FROM ta_verification WHERE identifier = ${email}`;
  expect(rows).toHaveLength(1);
  const data = typeof rows[0]?.data === "string" ? JSON.parse(rows[0].data) : rows[0]?.data;
  expect(data).toEqual({ attempts: 5 });
  expect(rows[0]?.consumed_at).not.toBeNull();
  expect(await otp.verify({ email, code, ip: null, userAgent: null })).toMatchObject({
    code: "too_many_attempts",
  });
});
