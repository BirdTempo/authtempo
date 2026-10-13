import { createAuth, type MailMessage } from "@authtempo/core";
import type { Sql } from "postgres";
import { afterEach, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabaseOf } from "./db.js";

// The documented hang (spec 8.9, amended 2026-10-13 by the plan 9d final fix
// wave; the README of this package): a before hook that queries core's client
// while its pool has one connection waits for the connection that the flow's
// transaction holds, and the transaction waits for the hook. The first test
// pins the fact with a 2-second timer. The second is the control: the same
// hook passes with a pool of two, so the hang comes from the pool size. The
// control waits 10 seconds, so a loaded machine cannot turn it red (plan 9h
// final fix wave, M-3).

/** Far below the 15-second test timeout, and far above one sign-in on a local Postgres. */
const HANG_MS = 2_000;
/** The control's wait: below the 15-second test timeout, far above a slow sign-in. */
const CONTROL_MS = 10_000;

let db: Awaited<ReturnType<typeof freshDatabaseOf>> | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

/** A sign-in by email code whose session hook queries `sql`: "done", "failed", or "timeout" after `waitMs`. */
async function signInWithQueryingHook(
  sql: Sql,
  waitMs: number,
): Promise<"done" | "failed" | "timeout"> {
  const sent: MailMessage[] = [];
  const auth = createAuth({
    baseURL: "https://api.example.com",
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: ["https://app.example.com"],
    storage: createPostgresAdapter(sql),
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    hooks: {
      session: {
        beforeCreate: async () => {
          await sql`SELECT 1`;
        },
      },
    },
  });
  const otp = auth.api.emailOtp;
  if (!otp) throw new Error("emailOtp is off");
  const email = "hang@example.com";
  expect(await otp.request({ email, ip: null })).toEqual({ ok: true, value: { sent: true } });
  const code = /\b(\d{6})\b/.exec(sent[0]?.text ?? "")?.[1] ?? "";
  // The second handler keeps a rejection handled: `close` ends the client under a hung verify.
  const verify = otp.verify({ email, code, ip: null, userAgent: null }).then(
    (r) => (r.ok ? ("done" as const) : ("failed" as const)),
    () => "failed" as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
  });
  try {
    return await Promise.race([verify, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

it("hangs a sign-in whose before hook queries core's client with a pool of one: the 2-second timer wins (spec 8.9, plan 9h)", async () => {
  db = await freshDatabaseOf(1);
  expect(await signInWithQueryingHook(db.sql, HANG_MS)).toBe("timeout");
});

it("signs in with the same hook on a pool of two: the hook's query takes the second connection (the control)", async () => {
  db = await freshDatabaseOf(2);
  expect(await signInWithQueryingHook(db.sql, CONTROL_MS)).toBe("done");
});
