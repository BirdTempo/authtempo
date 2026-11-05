import { createAuth, type MailMessage } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The cap of the sessions of one user on Postgres (decision 4 of plan 12q).
// A session create reads the newest `session.maxPerUser` live sessions of
// the user. Before its insert it ends the oldest past the cap, with the
// reason `capped`. `prepareSession` holds the row of a verified user first,
// so two sign-ins of that user wait on each other. The second reads the
// rows after the first commits, and ends the next oldest. So each ends one
// oldest session, and the count stays at the cap. Every row comes from a
// real request, through core's built output, with separate connections.
// Each race runs several rounds to meet more orders; a test that passes
// proves the orders it met, not every order.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const EMAIL = "ada@example.com";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const ROUNDS = 5;
const CAP = 3;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/** The engine on the test schema, with a cap of 3 and the session ends recorded. */
function world() {
  const mail: MailMessage[] = [];
  const ends: { id: string; reason: string }[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createPostgresAdapter(db.sql),
    limiter: OPEN,
    mail: { send: async (m) => void mail.push(m) },
    session: { maxPerUser: CAP },
    hooks: {
      session: { afterEnd: ({ session, reason }) => void ends.push({ id: session.id, reason }) },
    },
  });
  return { auth, mail, ends };
}
type World = ReturnType<typeof world>;

const post = (path: string, body: unknown) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify(body),
  });

/** The verify request of a new magic link of the address. The first one makes a verified user. */
async function link(w: World): Promise<Request> {
  expect((await w.auth.handle(post("/magic-link/request", { email: EMAIL }))).status).toBe(200);
  const text = w.mail.findLast((m) => m.to === EMAIL)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  return post("/magic-link/verify", { token });
}

/** One sign-in by a magic link, a few ms after the last, so the ids sort by it. */
async function signIn(w: World): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 3));
  expect((await w.auth.handle(await link(w))).status).toBe(200);
}

/** The ids of the user's sessions, oldest first. */
async function sessionIds(): Promise<string[]> {
  const rows = await db.sql<{ id: string }[]>`
    SELECT s.id FROM ta_session s JOIN ta_user u ON u.id = s.user_id
    WHERE u.email = ${EMAIL} ORDER BY s.id`;
  return rows.map((r) => r.id);
}

describe("the session cap on Postgres (decision 4 of plan 12q)", () => {
  it("ends the oldest session past the cap with the reason capped", async () => {
    const w = world();
    for (let i = 0; i < CAP; i++) await signIn(w);
    const [oldest, ...rest] = await sessionIds();
    expect(w.ends).toEqual([]);
    await signIn(w);
    expect(w.ends).toEqual([{ id: oldest, reason: "capped" }]);
    const now = await sessionIds();
    expect(now.length).toBe(CAP);
    expect(now.slice(0, CAP - 1)).toEqual(rest);
  });

  it("ends one oldest session for each of two sign-ins at once, and keeps the count at the cap", async () => {
    const w = world();
    for (let i = 0; i < CAP; i++) await signIn(w);
    for (let round = 0; round < ROUNDS; round++) {
      const before = await sessionIds();
      expect(before.length).toBe(CAP);
      const mark = w.ends.length;
      await new Promise((resolve) => setTimeout(resolve, 3));
      const requests = [await link(w), await link(w)];
      const answers = await Promise.all(requests.map((r) => w.auth.handle(r)));
      expect(answers.map((a) => a.status)).toEqual([200, 200]);
      // The two oldest, one by each sign-in.
      expect(w.ends.slice(mark).map((e) => e.reason)).toEqual(["capped", "capped"]);
      expect(new Set(w.ends.slice(mark).map((e) => e.id))).toEqual(new Set(before.slice(0, 2)));
      const after = await sessionIds();
      expect(after.length).toBe(CAP);
      expect(after[0]).toBe(before[2]);
    }
  });
});
