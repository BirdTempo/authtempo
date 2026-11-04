import { env } from "cloudflare:test";
import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { SoftAuthenticator } from "@authtempo/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The race of one passkey credential on the D1 binding, in the form of the
// Postgres test (plan 12n decision 18, rr-final L-5). It runs through core's
// built output. D1 transactions are not isolated, so two requests at once
// interleave their statements. The credential id is unique across users, and
// no read checks it before the write. So the unique key decides, and the
// loser answers passkey_failed with no throw. A delay sweep meets more orders
// of the writes.

const BASE = "https://api.example.com";
const APP = "https://app.example.com";
const RP = { rpID: "api.example.com", rpName: "Example", origins: [BASE] };
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
const ROUNDS = 8;

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

function world() {
  const sent: MailMessage[] = [];
  const storage: StorageAdapter = createD1Adapter(env.DB);
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP],
    storage,
    limiter: OPEN,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    passkey: { ...RP, signUp: { isolateLimiter: "allow" } },
  });
  /** A verified user with a session, through a magic link. */
  async function signIn(email: string) {
    await auth.api.requestMagicLink({ email, ip: null });
    const mail = [...sent].reverse().find((m) => m.to === email);
    const link = /token=([A-Za-z0-9_%-]+)/.exec(mail?.text ?? "")?.[1];
    if (!link) throw new Error("no link");
    const r = await auth.api.verifyMagicLink({
      token: decodeURIComponent(link),
      ip: null,
      userAgent: null,
    });
    if (!r.ok) throw new Error(r.code);
    if (!("token" in r.value)) throw new Error("the link answered a challenge");
    const s = await auth.api.getSession(r.value.token);
    if (!s) throw new Error("no session");
    // The session, not the user: the registration takes it (plan 12p).
    return s;
  }
  let ip = 0;
  const post = (path: string, body: unknown) =>
    new Request(`${BASE}/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP,
        "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      },
      body: JSON.stringify(body),
    });
  /** The passkey rows of one credential id. */
  const rowsOf = (credentialId: string) =>
    storage.findMany("passkey", [{ field: "credentialId", op: "eq", value: credentialId }]);
  return { auth, storage, signIn, post, rowsOf };
}

const delayed = <T>(ms: number, run: () => Promise<T>) =>
  new Promise<T>((done, failed) => {
    setTimeout(() => run().then(done, failed), ms);
  });

/** The bytes of a base64url text. */
function bytesOf(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}

describe("the race of one passkey credential on D1 (plan 12n decision 18)", () => {
  it("two users register one authenticator at once, a delay sweep: one passkey, and the other answers passkey_failed", async () => {
    const w = world();
    for (let delay = 0; delay < ROUNDS; delay++) {
      const ada = await w.signIn(`ada-${delay}@example.com`);
      const bob = await w.signIn(`bob-${delay}@example.com`);
      const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: BASE });
      // Each user gets its own challenge, and the one authenticator answers both.
      const ready = async (session: typeof ada) => {
        const options = await w.auth.api.passkeyRegistrationOptions({ session });
        if (!options.ok) throw new Error(options.code);
        const response = await soft.register(
          options.value.challenge,
          new TextEncoder().encode(session.user.id),
        );
        return () => w.auth.api.verifyPasskeyRegistration({ session, response });
      };
      const [a, b] = [await ready(ada), await ready(bob)];
      const answers = await Promise.all([a(), delayed(delay, b)]);
      expect(answers.map((r) => (r.ok ? "ok" : r.code)).sort(), `delay ${delay}`).toEqual([
        "ok",
        "passkey_failed",
      ]);
      const rows = await w.rowsOf(soft.credentialId);
      expect(rows, `delay ${delay}`).toHaveLength(1);
      const winner = answers[0]?.ok ? ada : bob;
      expect(rows[0]?.userId, `delay ${delay}`).toBe(winner.user.id);
    }
  });

  it("two passkey sign-ups of one authenticator at once, a delay sweep: one user, and the other answers passkey_failed", async () => {
    const w = world();
    for (let delay = 0; delay < ROUNDS; delay++) {
      const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: BASE });
      const ready = async (name: string) => {
        const res = await w.auth.handle(w.post("/passkey/sign-up/options", { name }));
        expect(res.status).toBe(200);
        const o = (await res.json()) as { challenge: string; user: { id: string } };
        const response = await soft.register(o.challenge, bytesOf(o.user.id));
        return () => w.auth.handle(w.post("/passkey/sign-up/verify", { response }));
      };
      const names = [`ana-${delay}`, `bea-${delay}`] as const;
      const [a, b] = [await ready(names[0]), await ready(names[1])];
      const answers = await Promise.all([a(), delayed(delay, b)]);
      const outcomes = await Promise.all(
        answers.map(
          async (r) => `${r.status} ${((await r.json()) as { error?: string }).error ?? "ok"}`,
        ),
      );
      expect(outcomes.sort(), `delay ${delay}`).toEqual(["200 ok", "400 passkey_failed"]);
      expect(await w.rowsOf(soft.credentialId), `delay ${delay}`).toHaveLength(1);
      // The loser's transaction wrote no user: one of the two names has a row.
      const users = await Promise.all(
        names.map((name) => w.storage.findMany("user", [{ field: "name", op: "eq", value: name }])),
      );
      expect(users.flat(), `delay ${delay}`).toHaveLength(1);
    }
  });
});
