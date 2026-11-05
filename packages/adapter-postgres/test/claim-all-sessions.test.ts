import { createAuth, createPbkdf2PasswordHash, type MailMessage } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The claim's session delete on Postgres (decision 3 of plan 12q). A store
// with no isolation ends at most two chunks of 50 sessions in the claim. It
// leaves the rest to the sweep through a pending-end row. Postgres isolates
// the claim's transaction and has no cap of queries. So here the claim ends
// every session of the claimant, and it writes no pending-end row.
// Every row comes from a real request, through core's built output.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";
/** Every request passes: the claimant signs in 119 times. */
const OPEN = { allow: async () => true };
/** More than the two chunks of 50 that a store with no isolation ends. */
const CLAIMANT_SESSIONS = 120;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

const post = (path: string, body: unknown) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify(body),
  });

/** The sessions of the address, oldest first. */
async function sessions() {
  return db.sql<{ id: string; proved: boolean }[]>`
    SELECT s.id, s.proved FROM ta_session s JOIN ta_user u ON u.id = s.user_id
    WHERE u.email = ${EMAIL} ORDER BY s.id`;
}

/** The pending-end rows of the address. */
async function pendingRows() {
  return db.sql<{ id: string }[]>`
    SELECT v.id FROM ta_verification v JOIN ta_user u ON u.id = v.identifier
    WHERE u.email = ${EMAIL} AND v.purpose = 'session-end'`;
}

describe("the claim's session delete on Postgres (decision 3 of plan 12q)", () => {
  it("ends every session of a claimant with more than 100, with the hook, and writes no pending-end row", async () => {
    const mail: MailMessage[] = [];
    const ends: { id: string; reason: string }[] = [];
    const auth = createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: createPostgresAdapter(db.sql),
      limiter: OPEN,
      mail: { send: async (m) => void mail.push(m) },
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
      // Above the claimant's sessions, so the cap ends none of them.
      session: { maxPerUser: 200 },
      hooks: {
        session: { afterEnd: ({ session, reason }) => void ends.push({ id: session.id, reason }) },
      },
    });
    // The claimant: the sign-up of the owner's address, then 119 sign-ins.
    const up = await auth.handle(post("/password/sign-up", { email: EMAIL, password: PASSWORD }));
    expect(up.status).toBe(200);
    for (let i = 1; i < CLAIMANT_SESSIONS; i++)
      expect(
        (await auth.handle(post("/password/sign-in", { email: EMAIL, password: PASSWORD }))).status,
      ).toBe(200);
    const before = (await sessions()).map((s) => s.id);
    expect(before.length).toBe(CLAIMANT_SESSIONS);
    expect(ends).toEqual([]);
    // The owner proves the address with a magic link.
    expect((await auth.handle(post("/magic-link/request", { email: EMAIL }))).status).toBe(200);
    const text = mail.findLast((m) => m.to === EMAIL)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    expect((await auth.handle(post("/magic-link/verify", { token }))).status).toBe(200);
    // The claim ended each claimant session once, in its own request.
    expect(ends.map((e) => e.reason)).toEqual(Array(CLAIMANT_SESSIONS).fill("claim"));
    expect(new Set(ends.map((e) => e.id))).toEqual(new Set(before));
    // Only the owner's proved session stays, and no row waits for the sweep.
    expect((await sessions()).map((s) => s.proved)).toEqual([true]);
    expect(await pendingRows()).toEqual([]);
  });
});
