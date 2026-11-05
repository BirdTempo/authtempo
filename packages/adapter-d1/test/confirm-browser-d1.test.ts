import { env } from "cloudflare:test";
import {
  type AuthConfig,
  createAuth,
  createPbkdf2PasswordHash,
  SIGN_UP_PROOF_COOKIE,
} from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The confirm of a sign-up from another browser on the D1 binding (plan 12q
// Task 1, decisions 1 and 2, ruling 11). The sign-up gives a proof: the
// cookie `__Host-tempo_signup`, and `signUpProof` in the body. A confirm
// with the proof keeps the sign-up's password. Any other confirm is a
// claim: the password goes, and the clicker gets a proved session. Every
// step is a real request through `auth.handle`, on a view of the binding
// that counts each query and refuses query 51, as D1 Free does (D1 limits
// page updated 21 April 2026, read 2026-10-24). The proof rides in the data
// of the verify row, and the claim deletes the password rows in one
// statement with or without the kept row. So a confirm with the proof and
// one without it send the same queries.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const BUDGET = 50;
const RAW = Symbol("raw");
const PASSWORD = "correct horse battery";
const FIRST = "the owner's own first password";
// The queries of the link's confirm, with the D1 limiter, with and without
// the proof. Run of 2026-11-05 09:13 CST on the owner's Mac Studio, load
// 8.5 13.1 11.4. A check at 21 failed with [22, 22].
const LINK_CONFIRM_QUERIES = 22;
// The code's confirm: the pin CONFIRM_QUERIES of
// password-verify-code-budget.test.ts, whose confirm carries no proof.
const CODE_CONFIRM_QUERIES = 24;

/** A view of `db` that counts each statement, and each statement of a batch. Query `BUDGET + 1` throws. */
function counting(db: D1Database) {
  const count = { queries: 0 };
  const tick = (n: number) => {
    if (count.queries + n > BUDGET)
      throw new Error("Too many API requests by single worker invocation.");
    count.queries += n;
  };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(target, key) {
        if (key === RAW) return target;
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "run" || key === "all" || key === "first" || key === "raw")
          return (...args: unknown[]) => {
            tick(1);
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          tick(statements.length);
          return target.batch(
            statements.map((s) => (s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s),
          );
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted as D1Database, count };
}

/** The engine on a counting view of the binding, with the D1 limiter on the same view. */
function make(password: NonNullable<AuthConfig["password"]> = {}) {
  const { db, count } = counting(env.DB);
  const mail: { to: string; text: string }[] = [];
  const auth = createAuth({
    baseURL: BASE,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: createD1Adapter(db),
    limiter: createD1Limiter(db),
    mail: { send: async (m) => void mail.push({ to: m.to, text: m.text }) },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), ...password },
  });
  return { auth, count, mail };
}
type World = ReturnType<typeof make>;

let ip = 0;
/** A JSON post from a browser whose jar holds `cookie`, or from a client with none. */
const post = (path: string, body: unknown, cookie: string | null = null) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

/** One request with the work after the answer, and its queries from a count of zero. */
async function measure(w: World, request: Request) {
  w.count.queries = 0;
  const after: Promise<unknown>[] = [];
  const res = await w.auth.handle(request, { waitUntil: (p) => void after.push(p) });
  await Promise.all(after);
  return {
    res,
    body: (await res.clone().json()) as Record<string, unknown>,
    queries: w.count.queries,
  };
}

/** The `name=value` part of the cookie `name` that an answer set, or null. */
function cookieOf(res: Response, name: string): string | null {
  return (
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${name}=`))
      ?.split(";")[0] ?? null
  );
}

const tokenIn = (text: string) =>
  decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
const linkOf = (w: World, email: string) =>
  tokenIn(w.mail.findLast((m) => m.to === email)?.text ?? "");
function codeOf(w: World, email: string): string {
  const code = /^(\d{6}) is your /.exec(w.mail.findLast((m) => m.to === email)?.text ?? "")?.[1];
  if (code === undefined) throw new Error(`no code to ${email}`);
  return code;
}

/** The rows of the address, read on the binding. */
async function state(email: string) {
  const user = await env.DB.prepare("SELECT id, email_verified AS v FROM ta_user WHERE email = ?")
    .bind(email)
    .first<{ id: string; v: number }>();
  const id = user?.id ?? "";
  const passwords = await env.DB.prepare("SELECT id FROM ta_password WHERE user_id = ?")
    .bind(id)
    .all<{ id: string }>();
  const sessions = await env.DB.prepare(
    "SELECT token_hash AS hash, proved FROM ta_session WHERE user_id = ? ORDER BY id",
  )
    .bind(id)
    .all<{ hash: string; proved: number }>();
  return {
    verified: user?.v === 1,
    passwords: passwords.results.map((r) => r.id),
    sessions: sessions.results.map((r) => ({ hash: r.hash, proved: r.proved === 1 })),
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A password sign-in from a client with no cookie: `status error`. */
async function signIn(w: World, email: string, password: string): Promise<string> {
  const { res, body } = await measure(w, post("/password/sign-in", { email, password }));
  return `${res.status} ${(body.error as string | undefined) ?? "ok"}`;
}

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare("DELETE FROM ta_limit").run();
});

describe("the confirm from another browser on D1 (plan 12q Task 1)", () => {
  it("claims from another browser and keeps in the sign-up's own, with the same queries", async () => {
    const w = make();
    // Two sign-ups under the default config: no session, only the proof.
    const ada = await measure(
      w,
      post("/password/sign-up", { email: "ada@example.com", password: PASSWORD }),
    );
    expect(ada.body).toEqual({ sent: true, signUpProof: expect.stringMatching(/^sp_/) });
    const bob = await measure(
      w,
      post("/password/sign-up", { email: "bob@example.com", password: PASSWORD }),
    );
    const bobProof = cookieOf(bob.res, SIGN_UP_PROOF_COOKIE);
    expect(bobProof).toBe(`${SIGN_UP_PROOF_COOKIE}=${bob.body.signUpProof as string}`);

    // Ada's link in a browser with no cookie: the claim.
    const claimed = await measure(
      w,
      post("/password/verify", { token: linkOf(w, "ada@example.com") }),
    );
    expect(claimed.body).toEqual({ verified: true, passwordKept: false });
    const session = cookieOf(claimed.res, "__Host-tempo_session");
    const after = await state("ada@example.com");
    expect(after.verified).toBe(true);
    expect(after.passwords).toEqual([]);
    expect(after.sessions).toEqual([
      { hash: await sha256Hex(session?.split("=")[1] ?? ""), proved: true },
    ]);
    expect(await signIn(w, "ada@example.com", PASSWORD)).toBe("401 invalid_credentials");
    // The first password, with no current password, on the session that the confirm opened.
    const set = await measure(w, post("/password/change", { newPassword: FIRST }, session));
    expect(set.body).toEqual({ ok: true });
    expect(await signIn(w, "ada@example.com", FIRST)).toBe("200 ok");

    // Bob's link in the browser of his sign-up, with its proof: the password stays.
    const kept = await measure(
      w,
      post("/password/verify", { token: linkOf(w, "bob@example.com") }, bobProof),
    );
    expect(kept.body).toEqual({ verified: true, passwordKept: true });
    expect((await state("bob@example.com")).passwords).toHaveLength(1);
    expect(await signIn(w, "bob@example.com", PASSWORD)).toBe("200 ok");

    expect([claimed.queries, kept.queries]).toEqual([LINK_CONFIRM_QUERIES, LINK_CONFIRM_QUERIES]);
    expect(LINK_CONFIRM_QUERIES).toBeLessThanOrEqual(BUDGET);
  });

  it("ends the sign-up's session when another browser claims", async () => {
    // The answer of plan 8: the sign-up opens a session of the unverified user.
    const w = make({ uniformSignUp: false });
    const up = await measure(
      w,
      post("/password/sign-up", { email: "ada@example.com", password: PASSWORD }),
    );
    const own = cookieOf(up.res, "__Host-tempo_session");
    expect(own).not.toBeNull();
    const before = await state("ada@example.com");
    expect(before.sessions).toEqual([
      { hash: await sha256Hex(own?.split("=")[1] ?? ""), proved: false },
    ]);
    // Another browser holds the session of the sign-up's own user, and no proof.
    const claimed = await measure(
      w,
      post("/password/verify", { token: linkOf(w, "ada@example.com") }, own),
    );
    expect(claimed.body).toEqual({ verified: true, passwordKept: false });
    const after = await state("ada@example.com");
    expect(after.passwords).toEqual([]);
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0]?.hash).not.toBe(before.sessions[0]?.hash);
    expect(after.sessions[0]?.proved).toBe(true);
  });

  it("keeps by code for a bearer app with the proof, and claims with none, with the same queries", async () => {
    const w = make({ verifyBy: "code" });
    const app = await measure(
      w,
      post("/password/sign-up", { email: "ada@example.com", password: PASSWORD }),
    );
    const proof = app.body.signUpProof as string;
    await measure(w, post("/password/sign-up", { email: "bob@example.com", password: PASSWORD }));
    const kept = await measure(
      w,
      post("/password/verify/code", {
        email: "ada@example.com",
        code: codeOf(w, "ada@example.com"),
        signUpProof: proof,
      }),
    );
    expect(kept.body).toMatchObject({ passwordKept: true });
    expect((await state("ada@example.com")).passwords).toHaveLength(1);
    const claimed = await measure(
      w,
      post("/password/verify/code", {
        email: "bob@example.com",
        code: codeOf(w, "bob@example.com"),
      }),
    );
    expect(claimed.body).toMatchObject({ passwordKept: false });
    expect((await state("bob@example.com")).passwords).toEqual([]);
    expect([kept.queries, claimed.queries]).toEqual([CODE_CONFIRM_QUERIES, CODE_CONFIRM_QUERIES]);
  });
});
