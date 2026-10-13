import { describe, expect, it } from "vitest";
import { requestEmailOtp, verifyEmailOtp } from "../src/engine/email-otp.js";
import {
  changePassword,
  passwordSignIn,
  passwordSignUp,
  requestPasswordReset,
  resetPassword,
} from "../src/engine/password.js";
import { resolveSession } from "../src/engine/sessions.js";
import { makeAuth, tokenFromMail } from "./helpers.js";
import { FAST, recordNextTransaction, sessionOnly, signUpAndVerify } from "./password-helpers.js";

/**
 * The session delete of a reset, a change, and a claim (plan 9h, index line
 * 179). With an `afterEnd` hook, each read row goes by id, so the hook fires
 * once per row the flow ended, then one delete by the flow's `where`. With no
 * hook, no flow needs the rows, so one statement deletes them all.
 */

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a new long password";

function endAuth(listen: boolean) {
  const events: { id: string; reason: string }[] = [];
  const auth = makeAuth({
    password: { hash: FAST },
    ...(listen
      ? {
          hooks: {
            session: {
              afterEnd: ({ session, reason }) => {
                events.push({ id: session.id, reason });
              },
            },
          },
        }
      : {}),
  });
  return { auth, events };
}

type EndAuth = ReturnType<typeof endAuth>["auth"];

async function signIn(auth: EndAuth): Promise<string> {
  const s = await sessionOnly(
    passwordSignIn(auth.config, { email: EMAIL, password: PASSWORD, ip: null, userAgent: null }),
  );
  if (!s.ok) throw new Error(s.code);
  return s.value.token;
}

const sessionDeletes = (writes: string[]) => writes.filter((w) => w === "delete:session").length;

describe("the session delete of a reset, a change, and a claim (plan 9h)", () => {
  for (const listen of [false, true]) {
    const label = listen ? "with an afterEnd hook, each row by id" : "with no hook, one statement";

    it(`a password change ends the other two sessions: ${label}`, async () => {
      const { auth, events } = endAuth(listen);
      await signUpAndVerify(auth, EMAIL, PASSWORD);
      const own = await signIn(auth);
      await signIn(auth);
      const session = await resolveSession(auth.config, own);
      if (!session) throw new Error("no session");
      // The verify link's session, one other sign-in, and the changer's own.
      expect(await auth.storage.findMany("session", [])).toHaveLength(3);
      // The verify link is a claim: it fired `afterEnd` for the sign-up's session.
      events.length = 0;
      const writes = recordNextTransaction(auth.storage);
      const r = await changePassword(auth.config, {
        session,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(r.ok).toBe(true);
      expect(sessionDeletes(writes)).toBe(listen ? 3 : 1);
      expect((await auth.storage.findMany("session", [])).map((s) => s.id)).toEqual([
        session.session.id,
      ]);
      expect(events.map((e) => e.reason)).toEqual(
        listen ? ["password_change", "password_change"] : [],
      );
    });

    it(`a reset by link ends all three sessions: ${label}`, async () => {
      const { auth, events } = endAuth(listen);
      await signUpAndVerify(auth, EMAIL, PASSWORD);
      await signIn(auth);
      await signIn(auth);
      const before = (await auth.storage.findMany("session", [])).map((s) => s.id);
      expect(before).toHaveLength(3);
      expect((await requestPasswordReset(auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
      const token = tokenFromMail(auth.mail.at(-1)?.text ?? "");
      // The verify link is a claim: it fired `afterEnd` for the sign-up's session.
      events.length = 0;
      const writes = recordNextTransaction(auth.storage);
      const r = await resetPassword(auth.config, {
        token,
        password: NEW_PASSWORD,
        ip: null,
        userAgent: null,
      });
      if (!r.ok) throw new Error(r.code);
      expect(sessionDeletes(writes)).toBe(listen ? 4 : 1);
      expect((await auth.storage.findMany("session", [])).map((s) => s.id)).toEqual([
        r.value.session.id,
      ]);
      expect(events.map((e) => e.id).sort()).toEqual(listen ? [...before].sort() : []);
    });

    it(`a claim by an email code ends the claimant's two sessions: ${label}`, async () => {
      const { auth, events } = endAuth(listen);
      // An unverified sign-up opens a session, and an unverified password sign-in another.
      const up = await passwordSignUp(auth.config, {
        email: EMAIL,
        password: PASSWORD,
        ip: null,
        userAgent: null,
      });
      if (!up.ok) throw new Error(up.code);
      await signIn(auth);
      const before = (await auth.storage.findMany("session", [])).map((s) => s.id);
      expect(before).toHaveLength(2);
      expect((await requestEmailOtp(auth.config, { email: EMAIL, ip: null })).ok).toBe(true);
      const code = /\b(\d{6})\b/.exec(auth.mail.at(-1)?.text ?? "")?.[1] ?? "";
      const writes = recordNextTransaction(auth.storage);
      const v = await verifyEmailOtp(auth.config, {
        email: EMAIL,
        code,
        ip: null,
        userAgent: null,
      });
      if (!v.ok) throw new Error(v.code);
      expect(sessionDeletes(writes)).toBe(listen ? 3 : 1);
      expect((await auth.storage.findMany("session", [])).map((s) => s.id)).toEqual([
        v.value.session.id,
      ]);
      expect(events.map((e) => [e.reason, e.id]).sort()).toEqual(
        listen ? before.map((id) => ["claim", id]).sort() : [],
      );
    });
  }
});
