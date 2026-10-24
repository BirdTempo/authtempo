import { createAuth, createPbkdf2PasswordHash, type StorageAdapter } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_84 } from "./db.js";

// The port of adapter-postgres/test/anonymous-upgrade-race.test.ts to MySQL
// 8.4 (plan 12i Task 7, ruling 36 L1), through core's built output, at
// REPEATABLE READ, the MySQL default.
// The claim is one conditional update of the anonymous sessions. So
// parallel sign-ins over one anonymous session run afterLink once. The
// core race test cannot catch a loss of the guard: the memory adapter runs
// one call at a time.

const BASE = "https://api.example.com";
const APP = "https://app.example.com";
const PASSWORD = "correct horse battery";
const ROUNDS = 8;
const WIDTH = 4;

/** `WIDTH` parallel password sign-ins over one anonymous session, in each of `ROUNDS` rounds. */
async function raceRounds(storage: StorageAdapter): Promise<void> {
  const links: string[] = [];
  const deleted: string[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async () => {} },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
    anonymous: { isolateLimiter: "allow" },
    hooks: {
      anonymous: {
        beforeLink: (e) => void links.push(`before ${e.anonymousUser.id} ${e.user.email}`),
        afterLink: async (e) => {
          // A slow hook widens the time between the commit and the delete.
          await new Promise((r) => setTimeout(r, 20));
          links.push(`after ${e.anonymousUser.id} ${e.user.email}`);
        },
      },
      user: { afterDelete: (e) => void deleted.push(e.user.id) },
    },
  });
  let ip = 0;
  const post = (path: string, body: unknown, cookie: string | null = null) =>
    new Request(`${BASE}/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP,
        "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const emails = Array.from({ length: WIDTH }, (_, i) => `u${i}@example.com`);
  for (const email of emails) {
    const r = await auth.handle(post("/password/sign-up", { email, password: PASSWORD }));
    expect(r.status).toBe(200);
  }
  for (let round = 0; round < ROUNDS; round++) {
    links.length = 0;
    const a = await auth.handle(post("/anonymous/sign-in", {}));
    expect(a.status).toBe(200);
    const line = a.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
    const jar = line?.split(";")[0] ?? "";
    const answers = await Promise.all(
      emails.map((email) =>
        auth.handle(post("/password/sign-in", { email, password: PASSWORD }, jar)),
      ),
    );
    for (const r of answers) expect(r.status).toBe(200);
    const after = links.filter((l) => l.startsWith("after"));
    expect(after, `round ${round}: ${links.join(" | ")}`).toHaveLength(1);
  }
  const anonymous = await storage.findMany("user", [
    { field: "isAnonymous", op: "eq", value: true },
  ]);
  expect(anonymous).toEqual([]);
  expect(new Set(deleted).size).toBe(ROUNDS);
  expect(deleted).toHaveLength(ROUNDS);
}

describe("parallel anonymous upgrades on MySQL 8.4 (plan 12i Task 7)", () => {
  it(`links one of ${WIDTH} parallel sign-ins over one anonymous session, in each of ${ROUNDS} rounds`, async () => {
    const db = await freshDatabase(MYSQL_84);
    try {
      await raceRounds(createMysqlAdapter(db.pool));
    } finally {
      await db.close();
    }
  }, 120_000);
});
