import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startHandoff } from "../src/engine/handoff.js";
import { passwordSignIn } from "../src/engine/password.js";
import { EMAIL_OTP_CONTRACT } from "../src/http/contract/email-otp.js";
import { HANDOFF_CONTRACT } from "../src/http/contract/handoff.js";
import { MAGIC_LINK_CONTRACT } from "../src/http/contract/magic-link.js";
import { PASSKEYS_CONTRACT } from "../src/http/contract/passkeys.js";
import { PASSWORD_CONTRACT } from "../src/http/contract/password.js";
import { SESSIONS_CONTRACT } from "../src/http/contract/sessions.js";
import { SessionAnswer } from "../src/http/contract/shapes.js";
import { SOCIAL_CONTRACT } from "../src/http/contract/social.js";
import { TOTP_CONTRACT } from "../src/http/contract/totp.js";
import type { RouteContract } from "../src/http/contract/types.js";
import { AUTH_ERROR_PARAM } from "../src/http/redirect.js";
import type { RouteKey } from "../src/http/route-list.js";
import { createRouter } from "../src/http/router.js";
import { coreRouteModules, coreRoutes, type RouteModule } from "../src/http/routes/index.js";
import { everyFeature, SOCIAL } from "./every-feature.js";
import { BASE_URL, get, makeAuth, post, tokenFromMail } from "./helpers.js";
import { pkce } from "./oauth-helpers.js";
import { FAST } from "./password-helpers.js";
import { codeNow, enrolled, PASSWORD, verifiedSession } from "./totp-helpers.js";

/** The contract of each module of part 1 (plan 11g Task 3), by module name. */
const PART1: Partial<Record<RouteModule, Partial<Record<RouteKey, RouteContract>>>> = {
  sessions: SESSIONS_CONTRACT,
  "magic-link": MAGIC_LINK_CONTRACT,
  social: SOCIAL_CONTRACT,
  passkeys: PASSKEYS_CONTRACT,
  password: PASSWORD_CONTRACT,
  totp: TOTP_CONTRACT,
  "email-otp": EMAIL_OTP_CONTRACT,
  handoff: HANDOFF_CONTRACT,
};

/** The eight contracts as one table. */
const MERGED: Partial<Record<RouteKey, RouteContract>> = Object.assign({}, ...Object.values(PART1));

/** 43 characters of a token body, as every `xx_` token of core has. */
const BODY43 = "A".repeat(43);

/** What a route answered: the status, and the code of a JSON error or of an `auth_error` redirect. */
interface Answer {
  status: number;
  code: string | null;
}

async function answerOf(res: Response): Promise<Answer> {
  if (res.status === 302 || res.status === 303) {
    const location = new URL(res.headers.get("location") ?? "");
    return { status: res.status, code: location.searchParams.get(AUTH_ERROR_PARAM) };
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("application/json")) {
    const body = (await res.json()) as { error?: string };
    return { status: res.status, code: body.error ?? null };
  }
  return { status: res.status, code: null };
}

/** The keys that the generator writes as `required` for an object schema. */
function requiredOf(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { io: "input" }) as { required?: string[] };
  return json.required ?? [];
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/** A world with every module of part 1 on, and a password hash that runs fast. */
function world() {
  const auth = makeAuth({
    password: { hash: FAST, uniformSignUp: false },
    passkey: { rpID: "api.example.com", rpName: "Example", origins: [BASE_URL] },
    handoff: { schemes: ["example://"] },
    social: SOCIAL,
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  const cookieOf = (token: string) => ({ cookie: `${auth.config.cookieName}=${token}` });
  return { auth, handle, cookieOf };
}

/** A fresh challenge of the user with the factor on, from a real password sign-in. */
async function challengeOf(auth: ReturnType<typeof makeAuth>, email: string): Promise<string> {
  const r = await passwordSignIn(auth.config, {
    email,
    password: PASSWORD,
    ip: "2.2.2.2",
    userAgent: "Agent/2",
  });
  if (!r.ok || !("twoFactor" in r.value)) throw new Error("the sign-in answered no challenge");
  return r.value.twoFactor.challenge;
}

/** The token of the last mail that the fake mail port recorded. */
function lastToken(auth: ReturnType<typeof makeAuth>): string {
  const last = auth.mail.at(-1);
  if (!last) throw new Error("no mail");
  return tokenFromMail(last.text);
}

describe("the contract of part 1 (plan 11g Task 3)", () => {
  it("gives each route of the eight modules a contract", () => {
    const mounted = new Map<RouteModule, Set<string>>();
    for (const m of coreRouteModules(everyFeature())) {
      const contract = PART1[m.module];
      if (!contract) continue;
      const keys = new Set<string>();
      for (const route of m.routes) {
        expect(route.key, `${m.module} ${route.method} ${route.path} has no key`).toBeDefined();
        if (!route.key) continue;
        expect(contract[route.key], `${route.key} has no contract`).toBeDefined();
        keys.add(route.key);
      }
      // The other way: a contract row names a route that the module mounts.
      for (const key of Object.keys(contract))
        expect(keys.has(key), `${m.module} mounts no route ${key}`).toBe(true);
      mounted.set(m.module, keys);
    }
    expect(mounted.size).toBe(8);
    const all = new Set([...mounted.values()].flatMap((keys) => [...keys]));
    expect(all.size).toBe(46);
    expect(Object.keys(MERGED).length).toBe(46);
  });

  it("holds a hand-read input to its schema", async () => {
    const w = world();
    await enrolled(w.auth, "totp@example.com");
    const challenge = await challengeOf(w.auth, "totp@example.com");
    const { challenge: pkceChallenge } = await pkce();
    const started = await startHandoff(w.auth.config, {
      challenge: pkceChallenge,
      redirect: "example://auth",
      ip: "1.1.1.1",
    });
    if (!started.ok) throw new Error(started.code);
    /** 42 characters: one short of a token body, so a token regex refuses it. */
    const SHORT = "A".repeat(42);
    /**
     * Each GET that reads its query by hand: a valid query, the keys the schema requires, and
     * the two answers. `wrong` is one key with a value of a wrong form, and the answer of the
     * route, for a GET whose schema holds a token to the engine's regex.
     */
    const VALID_QUERIES: {
      key: RouteKey;
      path: string;
      query: Record<string, string>;
      required: readonly string[];
      valid: Answer;
      missing: Answer | null;
      wrong?: { key: string; value: string; answer: Answer };
    }[] = [
      {
        key: "GET /magic-link/verify",
        path: "/magic-link/verify",
        query: { token: `ml_${BODY43}` },
        required: ["token"],
        valid: { status: 200, code: null },
        missing: { status: 302, code: "invalid_token" },
        wrong: {
          key: "token",
          value: `ml_${SHORT}`,
          answer: { status: 302, code: "invalid_token" },
        },
      },
      {
        key: "GET /social/:provider/start",
        path: "/social/google/start",
        query: { next: "/inbox" },
        required: [],
        valid: { status: 302, code: null },
        missing: null,
      },
      {
        key: "GET /social/:provider/callback",
        path: "/social/google/callback",
        query: { code: "c", state: "s", error: "" },
        required: [],
        valid: { status: 302, code: "invalid_token" },
        missing: null,
      },
      {
        key: "GET /password/verify",
        path: "/password/verify",
        query: { token: `pv_${BODY43}` },
        required: ["token"],
        valid: { status: 200, code: null },
        missing: { status: 302, code: "invalid_token" },
        wrong: {
          key: "token",
          value: `pv_${SHORT}`,
          answer: { status: 302, code: "invalid_token" },
        },
      },
      {
        key: "GET /password/reset",
        path: "/password/reset",
        query: { token: `pr_${BODY43}`, error: "password_policy" },
        required: ["token"],
        valid: { status: 200, code: null },
        missing: { status: 302, code: "invalid_token" },
        wrong: {
          key: "token",
          value: `pr_${SHORT}`,
          answer: { status: 302, code: "invalid_token" },
        },
      },
      {
        key: "GET /totp/challenge",
        path: "/totp/challenge",
        query: { challenge, method: "totp", backup: "1", error: "invalid_code" },
        required: ["challenge"],
        valid: { status: 200, code: null },
        missing: { status: 302, code: "invalid_token" },
        wrong: {
          key: "challenge",
          value: `tf_${SHORT}`,
          answer: { status: 302, code: "invalid_token" },
        },
      },
      {
        key: "GET /handoff/start",
        path: "/handoff/start",
        query: { challenge: pkceChallenge, redirect: "example://auth" },
        required: ["challenge", "redirect"],
        valid: { status: 200, code: null },
        missing: { status: 400, code: "invalid_body" },
        wrong: { key: "challenge", value: SHORT, answer: { status: 400, code: "invalid_body" } },
      },
      {
        key: "GET /handoff/continue",
        path: "/handoff/continue",
        query: { h: started.value.handoffId },
        required: ["h"],
        valid: { status: 200, code: null },
        missing: { status: 302, code: "invalid_token" },
        wrong: { key: "h", value: "abc", answer: { status: 302, code: "invalid_token" } },
      },
    ];
    const hand = Object.entries(MERGED)
      .filter(([, c]) => c.query?.parsedBy === "hand" || c.body?.parsedBy === "hand")
      .map(([key]) => key)
      .sort();
    expect(hand).toEqual(VALID_QUERIES.map((row) => row.key).sort());
    expect(hand.length).toBe(8);
    let wrongForms = 0;
    for (const row of VALID_QUERIES) {
      const contract = MERGED[row.key];
      const schema = contract?.query?.schema;
      if (!schema) throw new Error(`${row.key} has no query schema`);
      expect(contract.query?.parsedBy, row.key).toBe("hand");
      expect(contract.body, `${row.key} has a body`).toBeUndefined();
      expect(schema.safeParse(row.query).success, `${row.key}: the valid query`).toBe(true);
      expect(requiredOf(schema), row.key).toEqual(row.required);
      const res = await w.handle(get(`/auth${row.path}?${query(row.query)}`));
      expect(await answerOf(res), `${row.key}: the valid query`).toEqual(row.valid);
      for (const key of row.required) {
        const { [key]: _dropped, ...without } = row.query;
        expect(schema.safeParse(without).success, `${row.key} without ${key}`).toBe(false);
        const refused = await w.handle(get(`/auth${row.path}?${query(without)}`));
        expect(await answerOf(refused), `${row.key} without ${key}`).toEqual(row.missing);
      }
      if (!row.wrong) continue;
      wrongForms += 1;
      const wrong = { ...row.query, [row.wrong.key]: row.wrong.value };
      expect(schema.safeParse(wrong).success, `${row.key}: the wrong form`).toBe(false);
      const refused = await w.handle(get(`/auth${row.path}?${query(wrong)}`));
      expect(await answerOf(refused), `${row.key}: the wrong form`).toEqual(row.wrong.answer);
    }
    // The six GETs whose schema holds a token to the engine's regex.
    expect(wrongForms).toBe(6);
  });

  it("uses the contract's schema in the route", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const cookie = w.cookieOf(me.token);
    const { secret } = await enrolled(w.auth, "totp@example.com");
    const challenge = await challengeOf(w.auth, "totp@example.com");
    const { challenge: pkceChallenge } = await pkce();
    const started = await startHandoff(w.auth.config, {
      challenge: pkceChallenge,
      redirect: "example://auth",
      ip: "1.1.1.1",
    });
    if (!started.ok) throw new Error(started.code);
    // The real tokens of the three mailed links, so each verify route takes its valid body.
    await w.handle(post("/auth/magic-link/request", { email: "link@example.com" }));
    const magicToken = lastToken(w.auth);
    await w.handle(
      post("/auth/password/sign-up", { email: "new@example.com", password: PASSWORD }),
    );
    const verifyToken = lastToken(w.auth);
    await w.handle(post("/auth/password/reset/request", { email: "new@example.com" }));
    const resetToken = lastToken(w.auth);
    const INVALID_BODY: Answer = { status: 400, code: "invalid_body" };
    const INVALID_TOKEN: Answer = { status: 400, code: "invalid_token" };
    const PAGE_REFUSED: Answer = { status: 302, code: "invalid_token" };
    /**
     * Each POST whose body the route parses with its schema. A row holds a body that the schema
     * accepts, the session it needs, and the answer of a refused body. The password change goes
     * last: it changes the password of the session's user.
     */
    const VALID_BODIES: {
      key: RouteKey;
      body: Record<string, unknown>;
      path?: string;
      session?: true;
      headers?: Record<string, string>;
      /** Absent for a schema with no required key: it refuses no body of the form below. */
      refused?: Answer;
    }[] = [
      {
        key: "POST /sessions/revoke",
        body: { id: "x".repeat(26) },
        session: true,
        refused: INVALID_BODY,
      },
      {
        key: "POST /magic-link/request",
        body: { email: "ada@example.com", next: "/inbox" },
        refused: INVALID_BODY,
      },
      { key: "POST /magic-link/verify", body: { token: magicToken }, refused: INVALID_TOKEN },
      {
        key: "POST /social/:provider/link",
        path: "/social/google/link",
        body: { next: "/inbox" },
        session: true,
      },
      { key: "POST /social/apple/callback", body: { code: "c", state: "s" } },
      {
        key: "POST /passkey/register/verify",
        body: { response: { id: "cred", response: { clientDataJSON: "data" } }, name: "Key" },
        session: true,
        refused: INVALID_BODY,
      },
      {
        key: "POST /passkey/authenticate/verify",
        body: { response: { id: "cred", response: { clientDataJSON: "data" } } },
        refused: INVALID_BODY,
      },
      {
        key: "POST /passkeys/delete",
        body: { id: "x".repeat(26) },
        session: true,
        refused: INVALID_BODY,
      },
      {
        key: "POST /passkeys/rename",
        body: { id: "x".repeat(26), name: "Key" },
        session: true,
        refused: INVALID_BODY,
      },
      {
        key: "POST /password/sign-up",
        body: { email: "bob@example.com", password: PASSWORD, name: "Bob" },
        refused: INVALID_BODY,
      },
      {
        key: "POST /password/sign-in",
        body: { email: "ada@example.com", password: PASSWORD, next: "/inbox" },
        refused: INVALID_BODY,
      },
      { key: "POST /password/verify", body: { token: verifyToken }, refused: INVALID_TOKEN },
      {
        key: "POST /password/verify/resend",
        body: { email: "bob@example.com" },
        refused: INVALID_BODY,
      },
      {
        key: "POST /password/reset/request",
        body: { email: "ada@example.com", next: "/inbox" },
        refused: INVALID_BODY,
      },
      {
        key: "POST /password/reset",
        body: { token: resetToken, password: "another horse battery" },
        refused: INVALID_TOKEN,
      },
      {
        key: "POST /totp/setup",
        body: { password: PASSWORD },
        session: true,
        refused: INVALID_BODY,
      },
      { key: "POST /totp/enable", body: { code: "000000" }, session: true, refused: INVALID_BODY },
      { key: "POST /totp/disable", body: { code: "000000" }, session: true, refused: INVALID_BODY },
      {
        key: "POST /totp/backup-codes",
        body: { code: "000000" },
        session: true,
        refused: INVALID_BODY,
      },
      {
        key: "POST /totp/verify",
        body: { challenge: `tf_${BODY43}`, code: "000000", trustDevice: true },
        refused: INVALID_BODY,
      },
      {
        key: "POST /totp/challenge",
        body: { challenge, code: await codeNow(w.auth, secret), trustDevice: "1" },
        refused: PAGE_REFUSED,
      },
      { key: "POST /otp/request", body: { email: "ada@example.com" }, refused: INVALID_BODY },
      {
        key: "POST /otp/verify",
        body: { email: "ada@example.com", code: "000000" },
        refused: INVALID_BODY,
      },
      { key: "POST /otp/reset/request", body: { email: "ada@example.com" }, refused: INVALID_BODY },
      {
        key: "POST /otp/reset",
        body: { email: "ada@example.com", code: "000000", password: "another horse battery" },
        refused: INVALID_BODY,
      },
      {
        key: "POST /handoff/continue",
        body: { h: started.value.handoffId },
        session: true,
        headers: { origin: BASE_URL },
        refused: PAGE_REFUSED,
      },
      {
        key: "POST /handoff/redeem",
        body: { code: "x".repeat(26), verifier: "v".repeat(43) },
        refused: INVALID_BODY,
      },
      {
        key: "POST /password/change",
        body: { currentPassword: PASSWORD, newPassword: "another horse battery" },
        session: true,
        refused: INVALID_BODY,
      },
    ];
    const withBody = Object.entries(MERGED)
      .filter(([, c]) => c.body?.parsedBy === "zod")
      .map(([key]) => key)
      .sort();
    expect(withBody).toEqual(VALID_BODIES.map((row) => row.key).sort());
    expect(withBody.length).toBe(28);
    let refusals = 0;
    for (const row of VALID_BODIES) {
      const contract = MERGED[row.key];
      const schema = contract?.body?.schema;
      if (!schema) throw new Error(`${row.key} has no body schema`);
      const path = row.path ?? row.key.slice("POST ".length);
      const headers = { ...(row.session ? cookie : {}), ...row.headers };
      // Each required key absent, and one key that no schema names.
      const refused = { __x: 1 };
      expect(schema.safeParse(refused).success, `${row.key}: the refused body`).toBe(
        row.refused === undefined,
      );
      if (row.refused) {
        refusals += 1;
        const res = await w.handle(post(`/auth${path}`, refused, headers));
        expect(await answerOf(res), `${row.key}: the refused body`).toEqual(row.refused);
      }
      expect(schema.safeParse(row.body).success, `${row.key}: the valid body`).toBe(true);
      const res = await w.handle(post(`/auth${path}`, row.body, headers));
      const answer = await answerOf(res);
      expect(answer.status, `${row.key}: the valid body answered ${answer.code}`).toBeLessThan(500);
      if (row.refused) expect(answer, `${row.key}: the valid body`).not.toEqual(row.refused);
    }
    // The two social bodies have no required key, so no body of this form is refused.
    expect(refusals).toBe(26);
  });

  it("describes each answer as the wire JSON", async () => {
    const w = world();
    const me = await verifiedSession(w.auth);
    const cookie = w.cookieOf(me.token);
    const res = await w.handle(get("/auth/session", cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { expiresAt: unknown } };
    const parsed = SessionAnswer.parse(body);
    expect(parsed).toEqual(body);
    const { expiresAt } = body.session;
    expect(typeof expiresAt).toBe("string");
    if (typeof expiresAt !== "string") return;
    expect(new Date(expiresAt).toISOString()).toBe(expiresAt);
    // Three more answers of the session's user, each against its own schema.
    const answers: { key: RouteKey; request: Request }[] = [
      { key: "GET /sessions", request: get("/auth/sessions", cookie) },
      { key: "GET /totp", request: get("/auth/totp", cookie) },
      { key: "GET /passkeys", request: get("/auth/passkeys", cookie) },
      {
        key: "POST /passkey/register/options",
        request: post("/auth/passkey/register/options", {}, cookie),
      },
      {
        key: "POST /passkey/authenticate/options",
        request: post("/auth/passkey/authenticate/options", {}),
      },
    ];
    for (const { key, request } of answers) {
      const answer = MERGED[key]?.answer;
      if (answer?.kind !== "json") throw new Error(`${key} answers no JSON`);
      const r = await w.handle(request);
      expect(r.status, key).toBe(200);
      const json: unknown = await r.json();
      const result = answer.schema.safeParse(json);
      expect(result.success, `${key}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });
});
