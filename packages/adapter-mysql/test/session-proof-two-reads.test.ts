import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import type { RowDataPacket } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS, type MysqlDatabase } from "./db.js";

// The port of adapter-postgres/test/session-proof-two-reads.test.ts to MySQL
// 8.4 and 9.7 (decision 12 of plan 12p). The claim is one transaction here,
// so its flip and its session delete become visible at one commit. But a
// request resolves its session in two reads outside any transaction: the
// session row by its token, then the user row. A claim can commit between
// them. The session's `proved` flag is false, so the action is refused,
// and no row of it stays. Every row comes from a real request through
// `auth.handle`.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const SECRET = "0123456789abcdef0123456789abcdef";
const CLAIMED = "ada@example.com";
const PASSWORD = "correct horse battery";
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };

/**
 * Two instances of core on one database. The claimant's store runs `armed`
 * once, right before the user read that follows a read of a session row by
 * its token. The owner's store has no wrapper, so its claim commits at once.
 */
function world(db: MysqlDatabase, hook: boolean) {
  const sent: MailMessage[] = [];
  const endings: string[] = [];
  const inner = createMysqlAdapter(db.pool);
  const armed: { run: (() => Promise<void>) | null; session: string | null } = {
    run: null,
    session: null,
  };
  const claimantStore: StorageAdapter = {
    ...inner,
    findOne: async (model, where) => {
      const run = armed.run;
      const id = where.find((w) => w.field === "id")?.value;
      if (run && model === "user" && armed.session !== null && id === armed.session) {
        armed.run = null;
        await run();
      }
      const row = await inner.findOne(model, where);
      if (model === "session" && where.some((w) => w.field === "tokenHash") && row)
        armed.session = (row as { userId: string }).userId;
      return row;
    },
  };
  const config = (storage: StorageAdapter) =>
    createAuth({
      baseURL: BASE,
      secret: SECRET,
      trustedOrigins: [APP_ORIGIN],
      storage,
      limiter: OPEN,
      password: {
        hash: createPbkdf2PasswordHash({ iterations: 1000 }),
        uniformSignUp: false,
        requireVerified: false,
      },
      mail: { send: async (m) => void sent.push(m) },
      hooks: hook
        ? { session: { afterEnd: (e) => void endings.push(`${e.reason}:${e.session.id}`) } }
        : {},
    });
  return { owner: config(inner), claimant: config(claimantStore), armed, sent, endings };
}
type World = ReturnType<typeof world>;

const post = (path: string, body: unknown, token: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** `handle` that waits for the work after the answer too. */
async function handle(auth: ReturnType<typeof createAuth>, request: Request): Promise<Response> {
  const after: Promise<unknown>[] = [];
  const res = await auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return res;
}

/** The status and the error code of an answer: "200 ok", "403 email_unverified". */
async function answer(res: Response): Promise<string> {
  const body = (await res.clone().json()) as { error?: string };
  return `${res.status} ${body.error ?? "ok"}`;
}

/** The rows of the claimed user that an action of the claimant could leave. */
async function rowsOf(db: MysqlDatabase, userId: string) {
  const count = async (sql: string) =>
    Number((await db.pool.query<RowDataPacket[]>(sql, [userId]))[0][0]?.n ?? 0);
  const [user] = await db.pool.query<RowDataPacket[]>(
    "SELECT email_verified AS v FROM ta_user WHERE id = ?",
    [userId],
  );
  const [sessions] = await db.pool.query<RowDataPacket[]>(
    "SELECT proved FROM ta_session WHERE user_id = ? ORDER BY id",
    [userId],
  );
  return {
    verified: user[0] ? Number(user[0].v) === 1 : null,
    apiTokens: await count("SELECT COUNT(*) AS n FROM ta_api_token WHERE user_id = ?"),
    changes: await count(
      "SELECT COUNT(*) AS n FROM ta_verification WHERE identifier = ? AND purpose IN ('email-change', 'email-change-otp')",
    ),
    sessions: sessions.map((r) => Number(r.proved) === 1),
  };
}

/** The claimant's sign-up, the owner's magic link in the mail, and the request of its verify. */
async function scene(w: World) {
  const up = await handle(
    w.owner,
    post("/password/sign-up", { email: CLAIMED, password: PASSWORD }),
  );
  expect(await answer(up)).toBe("200 ok");
  const signedUp = (await up.json()) as {
    token: string;
    user: { id: string };
    session: { id: string };
  };
  expect((await handle(w.owner, post("/magic-link/request", { email: CLAIMED }))).status).toBe(200);
  const text = w.sent.findLast((m) => m.to === CLAIMED && /token=/.test(m.text))?.text ?? "";
  const link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  return {
    userId: signedUp.user.id,
    sessionId: signedUp.session.id,
    token: signedUp.token,
    verify: post("/magic-link/verify", { token: link }),
  };
}

const ACTIONS = [
  { name: "the API token create", path: "/tokens", body: { name: "kept" } },
  {
    name: "the change of address",
    path: "/user/change-email",
    body: { newEmail: "mallory@evil.example" },
  },
] as const;

for (const server of MYSQL_SERVERS)
  describe(`a session that a request resolved before the claim's commit, on MySQL ${server.version} (plan 12p decision 12)`, () => {
    let db: MysqlDatabase;
    beforeEach(async () => {
      db = await freshDatabase(server);
    });
    afterEach(async () => {
      await db.close();
    });

    for (const action of ACTIONS)
      for (const hook of [true, false])
        it(`refuses ${action.name} after the commit, and leaves no row of it (afterEnd hook ${hook})`, async () => {
          const w = world(db, hook);
          const s = await scene(w);
          let claimed: string | null = null;
          w.armed.run = async () => {
            claimed = await answer(await handle(w.owner, s.verify));
          };
          const acted = await handle(w.claimant, post(action.path, action.body, s.token));
          // The claim committed between the session read and the user read of the request.
          expect(w.armed.run).toBeNull();
          expect(claimed).toBe("200 ok");
          expect(await answer(acted)).toBe("403 email_unverified");
          // The claim deleted the claimant's session, and the owner holds one proved session.
          expect(await rowsOf(db, s.userId)).toEqual({
            verified: true,
            apiTokens: 0,
            changes: 0,
            sessions: [true],
          });
          expect(w.sent.filter((m) => m.to === "mallory@evil.example")).toEqual([]);
          expect(w.endings).toEqual(hook ? [`claim:${s.sessionId}`] : []);
        });
  });
