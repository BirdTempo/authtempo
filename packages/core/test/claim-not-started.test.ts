import { describe, expect, it } from "vitest";
import {
  type AuthConfig,
  type MailMessage,
  type ResolvedConfig,
  resolveConfig,
} from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
import { CLAIM_LEASE_MS, claimLeaseId, claimNotStarted } from "../src/engine/users.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import type { UserRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { d1Like } from "./d1-like.js";
import { APP_ORIGIN, BASE_URL, recordAddress, recordCredential, tokenFromMail } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import {
  type FakeIdToken,
  fakeJwt,
  GOOGLE,
  googleClaims,
  tokenEndpoint,
} from "./social-helpers.js";

// The claim check of a sign-up, `claimNotStarted` (ruling 26 of plan 12p).
// A flow fixes its time at its start, and a claim writes its lease with that
// time. So a proof that waits 60 seconds or more before its user read writes
// a lease that is stale at its birth. The check of a sign-up that created
// the user must count that lease. Each scene runs on the D1 view of the
// memory store (`d1-like.ts`). It has no transaction lock, and each
// statement lands at once. A gate before each statement of a flow pauses
// that flow at a named point. Every row comes from a flow of the product.

const CLAIMED = recordAddress("ada@example.com");
const PW = recordCredential("claimant password 1");
const COOKIE = "__Host-tempo_session";
/** The calls of the port that send a statement. */
const STATEMENTS = new Set([
  "create",
  "createMany",
  "findOne",
  "findMany",
  "update",
  "delete",
  "deleteRows",
]);

/** A wait before a statement of one flow, with the call, the model, and the arguments. */
type Gate = (op: string, model: string, args: unknown[]) => Promise<void>;

function latch() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * One memory store, one clock, one limiter, and one mail list. Each flow
 * gets its own D1 view of the store, with its own gate.
 */
function world(opts: { uniform?: boolean } = {}) {
  let current = new Date("2026-11-04T00:00:00.000Z");
  const clock = { now: () => current };
  const mem = createMemoryAdapter();
  const limiter = createMemoryLimiter(clock);
  const mail: MailMessage[] = [];
  const tokens: Record<string, FakeIdToken> = {};
  const { fetchFn } = tokenEndpoint("idtok-claimant");
  const config = (gate?: Gate): AuthConfig => {
    const gated = new Proxy(mem, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (!STATEMENTS.has(String(key))) return value.bind(target);
        return async (...args: unknown[]) => {
          await gate?.(String(key), String(args[0]), args);
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    }) as StorageAdapter;
    return {
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: d1Like({ storage: gated } as unknown as ResolvedConfig).storage,
      limiter,
      clock,
      mail: {
        send: async (m) => {
          mail.push(m);
        },
      },
      password: { hash: FAST, uniformSignUp: opts.uniform === true },
      social: { google: GOOGLE, fetch: fetchFn },
      jwt: fakeJwt(tokens),
    };
  };
  /** The routes on a view with `gate`. `handle` waits for the work after the answer too. */
  const auth = (gate?: Gate) => {
    const a = createAuth(config(gate));
    return {
      async handle(request: Request): Promise<Response> {
        const after: Promise<unknown>[] = [];
        const res = await a.handle(request, { waitUntil: (p) => void after.push(p) });
        await Promise.all(after);
        return res;
      },
    };
  };
  return {
    mem,
    mail,
    tokens,
    clock,
    config,
    auth,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}
type World = ReturnType<typeof world>;

let ip = 0;
/** A JSON request of the routes, with the Origin of the app and a new client IP. */
function req(path: string, body: unknown) {
  return new Request(`${BASE_URL}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": `198.51.100.${(++ip % 250) + 1}`,
    },
    body: JSON.stringify(body),
  });
}

/** The status and the error code of an answer, and whether it set a session cookie. */
async function answer(res: Response): Promise<string> {
  const text = await res.clone().text();
  let code = "ok";
  try {
    code = (JSON.parse(text || "{}") as { error?: string }).error ?? "ok";
  } catch {
    code = "page";
  }
  const set = res.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=`) && !/=;/.test(c));
  return `${res.status} ${code}${set ? " a session" : ""}`;
}

async function userAt(w: World, email: string): Promise<UserRow> {
  const user = await w.mem.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error(`no user at ${email}`);
  return user;
}

/** A magic link of `email`, mailed now: the request of its verify. */
async function linkOf(w: World, email: string): Promise<Request> {
  expect((await w.auth().handle(req("/magic-link/request", { email }))).status).toBe(200);
  const mail = w.mail.findLast((m) => m.to === email);
  return req("/magic-link/verify", { token: tokenFromMail(mail?.text ?? "") });
}

/** The claimant's Google sign-in: its Google account reports the address unverified. */
async function googleSignIn(w: World, gate?: Gate): Promise<string> {
  const config = resolveConfig(w.config(gate));
  const started = await startSocial(config, { provider: "google", next: "/home", ip: "1.1.1.1" });
  if (!started.ok) throw new Error(started.code);
  const url = new URL(started.value.location);
  w.tokens["idtok-claimant"] = googleClaims(url.searchParams.get("nonce") ?? "", {
    sub: "g-claimant",
    email: CLAIMED,
    email_verified: false,
  });
  const done = await completeSocial(config, {
    provider: "google",
    state: url.searchParams.get("state") ?? "",
    code: "c",
    error: null,
    bindToken: started.value.bindToken,
    ip: null,
    userAgent: null,
  });
  if (!done.ok) return done.code;
  return "token" in done.value ? "ok a session" : "ok a challenge";
}

/** True for a read of a user by its address. */
const byAddress = (args: unknown[]) =>
  (args[1] as { field: string }[]).some((w) => w.field === "email");
/** True for the claim's flip: an update of a user that sets the verified flag. */
const setsVerified = (args: unknown[]) =>
  (args[2] as { emailVerified?: boolean }).emailVerified === true;

type SignUp = "password" | "uniform" | "social";

/**
 * The owner's magic link claims while the claimant's sign-up of the same
 * address runs. The owner asks for the link before any user holds the
 * address. Its proof fixes its time and waits before its user read. Then the
 * clock moves `late` ms. The sign-up creates the user and waits before it
 * writes the row that a claim deletes. The claim reads the user, takes its
 * lease, deletes, and waits before its flip. Then the sign-up writes its row
 * and runs its check. Last the claim flips and ends.
 */
async function race(kind: SignUp, late: number) {
  const w = world({ uniform: kind === "uniform" });
  const verify = await linkOf(w, CLAIMED);
  const atRead = latch();
  const goRead = latch();
  const atFlip = latch();
  const goFlip = latch();
  const atRow = latch();
  const goRow = latch();
  let read = false;
  let flip = false;
  let row = false;
  const owner = w.auth(async (op, model, args) => {
    if (!read && op === "findOne" && model === "user" && byAddress(args)) {
      read = true;
      atRead.open();
      await goRead.wait;
    }
    if (!flip && op === "update" && model === "user" && setsVerified(args)) {
      flip = true;
      atFlip.open();
      await goFlip.wait;
    }
  });
  // The row that the claim deletes: the password, or the identity of Google.
  const gate: Gate = async (op, model, args) => {
    const mine =
      kind === "social"
        ? model === "identity" && (args[1] as { provider?: string }).provider === "google"
        : model === "password";
    if (!row && op === "create" && mine) {
      row = true;
      atRow.open();
      await goRow.wait;
    }
  };
  const claim = owner.handle(verify);
  await atRead.wait;
  w.advance(late);
  const signUp =
    kind === "social"
      ? googleSignIn(w, gate)
      : w
          .auth(gate)
          .handle(req("/password/sign-up", { email: CLAIMED, password: PW }))
          .then(answer);
  await atRow.wait;
  goRead.open();
  await atFlip.wait;
  const user = await userAt(w, CLAIMED);
  const lease = await w.mem.findOne("verification", [
    { field: "id", op: "eq", value: claimLeaseId(user.id) },
  ]);
  goRow.open();
  const up = await signUp;
  goFlip.open();
  const done = await answer(await claim);
  return { w, user, lease, up, done };
}

describe("a sign-up beside a claim whose lease is stale at its birth (ruling 26 of plan 12p)", () => {
  for (const late of [CLAIM_LEASE_MS + 1_000, 0]) {
    const at = `${late / 1000} s`;

    it(`the password sign-up keeps no password when the claim's time is ${at} old at its lease`, async () => {
      const { w, user, lease, up, done } = await race("password", late);
      // The claim wrote its lease with the time of its start: stale at 61 s, live at 0 s.
      expect(lease?.expiresAt).toEqual(new Date(Date.parse("2026-11-04T00:01:00.000Z")));
      expect((lease?.expiresAt ?? new Date(0)) < w.clock.now()).toBe(late > 0);
      expect(up).toBe("409 email_taken_unverified");
      expect(done).toBe("200 ok a session");
      expect((await userAt(w, CLAIMED)).emailVerified).toBe(true);
      expect(
        await w.mem.findMany("password", [{ field: "userId", op: "eq", value: user.id }]),
      ).toEqual([]);
      const signIn = await w
        .auth()
        .handle(req("/password/sign-in", { email: CLAIMED, password: PW }));
      expect(await answer(signIn)).toBe("401 invalid_credentials");
      expect(
        await w.mem.findMany("session", [{ field: "userId", op: "eq", value: user.id }]),
      ).toHaveLength(1);
    });

    it(`the uniform sign-up keeps no password when the claim's time is ${at} old at its lease`, async () => {
      const { w, user, lease, up, done } = await race("uniform", late);
      expect((lease?.expiresAt ?? new Date(0)) < w.clock.now()).toBe(late > 0);
      // The uniform answer tells nothing.
      expect(up).toBe("200 ok");
      expect(done).toBe("200 ok a session");
      expect((await userAt(w, CLAIMED)).emailVerified).toBe(true);
      expect(
        await w.mem.findMany("password", [{ field: "userId", op: "eq", value: user.id }]),
      ).toEqual([]);
      const signIn = await w
        .auth()
        .handle(req("/password/sign-in", { email: CLAIMED, password: PW }));
      expect(await answer(signIn)).toBe("401 invalid_credentials");
    });

    it(`the social sign-up of a new user keeps no identity when the claim's time is ${at} old at its lease`, async () => {
      const { w, user, lease, up, done } = await race("social", late);
      expect((lease?.expiresAt ?? new Date(0)) < w.clock.now()).toBe(late > 0);
      expect(up).toBe("email_taken_unverified");
      expect(done).toBe("200 ok a session");
      expect((await userAt(w, CLAIMED)).emailVerified).toBe(true);
      expect(
        (await w.mem.findMany("identity", [{ field: "userId", op: "eq", value: user.id }])).map(
          (i) => i.provider,
        ),
      ).toEqual(["email"]);
      // The claimant's Google account signs in to nothing.
      expect(await googleSignIn(w)).toBe("email_taken_unverified");
      expect(
        await w.mem.findMany("session", [{ field: "userId", op: "eq", value: user.id }]),
      ).toHaveLength(1);
    });
  }
});

/**
 * The owner's claim of the claimant's user, paused right after its lease:
 * the gate waits before the claim's delete of the identities. `go` lets the
 * claim end, and `claim` is its answer.
 */
async function claimAtLease(w: World) {
  const verify = await linkOf(w, CLAIMED);
  const at = latch();
  const go = latch();
  let paused = false;
  const owner = w.auth(async (op, model) => {
    if (!paused && op === "delete" && model === "identity") {
      paused = true;
      at.open();
      await go.wait;
    }
  });
  const claim = owner.handle(verify).then(answer);
  await at.wait;
  return { claim, go };
}

/** `claimNotStarted` of `user` in a transaction of the memory store, at the time of the clock. */
function check(w: World, user: UserRow, isolated = false): Promise<boolean> {
  return w.mem.transaction((tx) =>
    claimNotStarted(isolated ? { ...tx, isolated: true } : tx, user, w.clock.now()),
  );
}

/** The claimant: a password sign-up of the owner's address, unverified. */
async function claimant(w: World): Promise<UserRow> {
  const up = await w.auth().handle(req("/password/sign-up", { email: CLAIMED, password: PW }));
  expect(await answer(up)).toBe("200 ok a session");
  const user = await userAt(w, CLAIMED);
  expect(user.emailVerified).toBe(false);
  return user;
}

describe("claimNotStarted in a memory transaction (open point 2 of the Task 2b review of plan 12p)", () => {
  it("answers false for a verified user with no lease", async () => {
    const w = world();
    // A magic link of a new address makes a verified user, and no claim runs.
    const email = recordAddress("bea@example.com");
    expect(await answer(await w.auth().handle(await linkOf(w, email)))).toBe("200 ok a session");
    const user = await userAt(w, email);
    expect(user.emailVerified).toBe(true);
    expect(
      await w.mem.findOne("verification", [
        { field: "id", op: "eq", value: claimLeaseId(user.id) },
      ]),
    ).toBeNull();
    expect(await check(w, user)).toBe(false);
  });

  it("answers true for an unverified user with no lease", async () => {
    const w = world();
    expect(await check(w, await claimant(w))).toBe(true);
  });

  it("answers false for an unverified user with a live lease", async () => {
    const w = world();
    const user = await claimant(w);
    const { claim, go } = await claimAtLease(w);
    const lease = await w.mem.findOne("verification", [
      { field: "id", op: "eq", value: claimLeaseId(user.id) },
    ]);
    expect((lease?.expiresAt ?? new Date(0)) > w.clock.now()).toBe(true);
    expect((await userAt(w, CLAIMED)).emailVerified).toBe(false);
    expect(await check(w, user)).toBe(false);
    go.open();
    expect(await claim).toBe("200 ok a session");
  });

  it("answers false for an unverified user with a stale lease", async () => {
    const w = world();
    const user = await claimant(w);
    const { claim, go } = await claimAtLease(w);
    w.advance(CLAIM_LEASE_MS + 1_000);
    const lease = await w.mem.findOne("verification", [
      { field: "id", op: "eq", value: claimLeaseId(user.id) },
    ]);
    expect((lease?.expiresAt ?? new Date(0)) < w.clock.now()).toBe(true);
    expect((await userAt(w, CLAIMED)).emailVerified).toBe(false);
    expect(await check(w, user)).toBe(false);
    go.open();
    expect(await claim).toBe("200 ok a session");
  });

  it("answers true on an isolated port with a live lease, because it reads no lease there", async () => {
    // The lease comes from a real claim on the memory store. The port view
    // says isolated, as Postgres and MySQL do, where a claim writes no lease.
    const w = world();
    const user = await claimant(w);
    const { claim, go } = await claimAtLease(w);
    expect(
      await w.mem.findOne("verification", [
        { field: "id", op: "eq", value: claimLeaseId(user.id) },
      ]),
    ).not.toBeNull();
    expect(await check(w, user, true)).toBe(true);
    go.open();
    expect(await claim).toBe("200 ok a session");
  });
});
