import {
  createAuth,
  createPbkdf2PasswordHash,
  type MailMessage,
  type StorageAdapter,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { createMysqlAdapter } from "../src/index.js";
import { freshDatabase, MYSQL_SERVERS } from "./db.js";

// A mailbox proof is final on D1, SQLite, and memory (decision 10 of plan
// 12o). On MySQL `keep` answers false, because InnoDB isolates the open
// transaction. So a throw after `keep` undoes the whole claim, and no after
// point of the claim runs (L3 of the Task 3 review). Every row comes from a
// real request, through core's built output.

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";

/** A store whose next transaction throws at its session insert after it called `keep`. */
function throwAfterKeep(storage: StorageAdapter) {
  const seen = { armed: false, kept: 0, thrown: 0 };
  const store: StorageAdapter = {
    ...storage,
    transaction: <T>(fn: (tx: StorageAdapter) => Promise<T>): Promise<T> =>
      storage.transaction((tx) => {
        let kept = false;
        return fn({
          ...tx,
          keep: async () => {
            const answer = await tx.keep();
            if (seen.armed) {
              kept = true;
              seen.kept++;
            }
            return answer;
          },
          create: async (m, d) => {
            if (kept && seen.thrown === 0 && m === "session") {
              seen.thrown++;
              throw new Error("a throw after keep");
            }
            return tx.create(m, d);
          },
        });
      }),
  };
  return { store, seen };
}

for (const server of MYSQL_SERVERS)
  describe(`a throw after keep on MySQL ${server.version} (L3 of the 12o Task 3 review)`, () => {
    it("undoes the whole claim of a magic link, and fires no after point of the claim", async () => {
      const db = await freshDatabase(server);
      try {
        const raw = createMysqlAdapter(db.pool);
        const { store, seen } = throwAfterKeep(raw);
        const mail: MailMessage[] = [];
        const verify: string[] = [];
        const ended: string[] = [];
        const auth = createAuth({
          baseURL: "https://api.example.com",
          secret: "0123456789abcdef0123456789abcdef",
          trustedOrigins: ["https://app.example.com"],
          storage: store,
          limiter: { allow: async () => true },
          mail: { send: async (m) => void mail.push(m) },
          password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
          hooks: {
            user: {
              beforeVerify: (e) => void verify.push(`before:${e.via}`),
              afterVerify: (e) => void verify.push(`after:${e.via}`),
            },
            // A listener of `afterEnd`: the claim reads its sessions and ends them by `deleteRows`.
            session: { afterEnd: (e) => void ended.push(`${e.reason}:${e.session.id}`) },
          },
        });
        const password = auth.api.password;
        if (!password) throw new Error("no password api");
        // The claimant: a sign-up of the address and a sign-in, with the address unverified.
        const input = { email: EMAIL, password: PASSWORD, ip: null, userAgent: null };
        expect((await password.signUp(input)).ok).toBe(true);
        expect((await password.signIn(input)).ok).toBe(true);
        const user = await raw.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
        if (!user) throw new Error("no user");
        const byUser = [{ field: "userId" as const, op: "eq" as const, value: user.id }];
        const sessions = (await raw.findMany("session", byUser)).map((r) => r.id).sort();
        expect(sessions).toHaveLength(2);
        // The owner's magic link claims the user, and throws at its session insert after `keep`.
        expect((await auth.api.requestMagicLink({ email: EMAIL, ip: null })).ok).toBe(true);
        const text = mail.findLast((m) => m.to === EMAIL)?.text ?? "";
        const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
        seen.armed = true;
        await expect(
          auth.api.verifyMagicLink({ token, ip: null, userAgent: null }),
        ).rejects.toThrow("a throw after keep");
        expect(seen).toEqual({ armed: true, kept: seen.kept, thrown: 1 });
        expect(seen.kept).toBeGreaterThan(0);
        // The rollback undid the whole claim: the claimant keeps its rows.
        const after = await raw.findOne("user", [{ field: "id", op: "eq", value: user.id }]);
        expect(after?.emailVerified).toBe(false);
        expect((await raw.findMany("session", byUser)).map((r) => r.id).sort()).toEqual(sessions);
        expect(await raw.findMany("password", byUser)).toHaveLength(1);
        expect(await raw.findMany("identity", byUser)).toEqual([]);
        // `keep` answered false, so no after point of the claim ran.
        expect(verify).toEqual(["before:magic_link"]);
        expect(ended).toEqual([]);
      } finally {
        await db.close();
      }
    }, 60_000);
  });
