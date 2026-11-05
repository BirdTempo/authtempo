import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  answer,
  BASE,
  BUDGET,
  CLAIMED,
  call,
  clear,
  DEVICE_GRANT,
  endings,
  everyTable,
  FLIP,
  form,
  get,
  googleIdToken,
  lastTo,
  mail,
  make,
  measure,
  NEW,
  OLD,
  ownerLink,
  PHONE,
  post,
  REDIRECT,
  RESOURCE,
  sessionsOf,
  setToken,
  sms,
  tokenIn,
  userId,
  verified,
  type World,
} from "./session-proof-world.js";

// The session proof on D1 (decision 12 of plan 12p). D1 does not isolate a
// transaction, so each statement of a claim lands at once. A claimant's
// session is still there between the claim's flip and its session delete.
// In that gap the user reads as verified, and the session flag `proved` is
// false. The door of a claimed session refuses such a session and ends it
// (ruling 13 of plan 12q). So each action of the claimant answers 401.
//
// Each scene runs twice from an empty database, with real requests through
// `auth.handle`. The control run makes the claim alone. The other run sends
// the claimant's requests right after the flip, as a parallel invocation
// does. Then every table must be as the control left it. So no row of the
// action stays: no token, no change of address, no OAuth code or consent.
// The 12o probes of the window are the start (tools/12o/tmp/final and fwb).

/** The PKCE challenge of a verifier, as a client sends it. */
async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The claimant: a password sign-up of the owner's address and a sign-in, with 2 sessions. */
async function claimant(w: World) {
  const up = await call(w, post("/password/sign-up", { email: CLAIMED, password: OLD }));
  expect(await answer(up)).toBe("200 ok");
  const confirm = tokenIn(lastTo(CLAIMED));
  const id = await userId(CLAIMED);
  const first = (await sessionsOf(id)).map((s) => s.id);
  const signIn = await call(w, post("/password/sign-in", { email: CLAIMED, password: OLD }));
  expect(await answer(signIn)).toBe("200 ok");
  const sessions = (await sessionsOf(id)).map((s) => s.id);
  expect(sessions).toHaveLength(2);
  // The sign-in's session is fresh: it is the one that acts.
  const actor = sessions.find((s) => !first.includes(s)) ?? "";
  return { id, sessions, actor, token: setToken(signIn), confirm };
}
type Claimant = Awaited<ReturnType<typeof claimant>>;

/** A proof of the claimed address by its owner. The request is built before the race. */
interface Proof {
  name: string;
  prepare: (w: World, c: Claimant) => Promise<Request>;
}

const MAGIC_LINK: Proof = { name: "a magic link", prepare: (w) => ownerLink(w) };
const ID_TOKEN: Proof = {
  name: "an ID token",
  prepare: (w) => googleIdToken(w, "g-owner", true),
};
const RESET_LINK: Proof = {
  name: "a reset link",
  prepare: async (w) => {
    expect((await call(w, post("/password/reset/request", { email: CLAIMED }))).status).toBe(200);
    return post("/password/reset", { token: tokenIn(lastTo(CLAIMED)), password: NEW });
  },
};
/** The verify link of the claimant's sign-up, in the owner's mailbox. The claim keeps that password. */
const VERIFY_LINK: Proof = {
  name: "the verify link",
  prepare: async (_w, c) => post("/password/verify", { token: c.confirm }),
};

/**
 * The answer of a request with the claimant's session at the flip. The first
 * request meets the door of a claimed session, which ends the session (ruling
 * 13 of plan 12q). Each later request finds no session.
 */
const DEAD = "401 unauthorized";

/** A public client of the register route, with the device grant. */
async function oauthClient(w: World): Promise<string> {
  const res = await call(
    w,
    new Request(`${BASE}/auth/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
      }),
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The organization acme of a verified owner, with a second verified user who is no member. */
async function acme(w: World) {
  const boss = await verified(w, "boss@acme.example");
  const made = await call(w, post("/organizations/create", { slug: "acme", name: "Acme" }, boss));
  expect(await answer(made)).toBe("200 ok");
  const organizationId = ((await made.json()) as { organization: { id: string } }).organization.id;
  await verified(w, "carol@acme.example");
  return { boss, organizationId, carol: await userId("carol@acme.example") };
}

/** The state that the action of a scene needs, made through the routes before the race. */
type Ctx = Record<string, string>;

/** An open flow of inventory-window.md section 1, or a gate of a closed flow, as requests at the flip. */
interface Flow {
  name: string;
  setup?: (w: World, c: Claimant) => Promise<Ctx>;
  /** The claimant's requests at the flip, each with its name. */
  act: (w: World, c: Claimant, ctx: Ctx) => Promise<Record<string, string>>;
  /** The answer of each request. */
  want: () => Record<string, string>;
  /** A request after the claim, in both runs, such as the poll of a device grant. */
  later?: (w: World, c: Claimant, ctx: Ctx) => Promise<string>;
  /**
   * The purpose of a verification row that the request with no session holds,
   * as for any visitor. The row names no user, and the act checks that.
   */
  visitor?: string;
}

async function each(
  w: World,
  requests: [string, Request | (() => Promise<Request>)][],
): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  for (const [name, request] of requests)
    seen[name] = await answer(
      await call(w, typeof request === "function" ? await request() : request),
    );
  return seen;
}

const TOKEN: Flow = {
  name: "the API token create",
  act: (w, c) => each(w, [["create", post("/tokens", { name: "kept" }, c.token)]]),
  want: () => ({ create: DEAD }),
};

const CHANGE_OF_ADDRESS: Flow = {
  name: "the change of address",
  act: async (w, c) => {
    const seen = await each(w, [
      ["link", post("/user/change-email", { newEmail: "mallory@evil.example" }, c.token)],
      [
        "code",
        post("/user/change-email", { newEmail: "mallory@evil.example", method: "code" }, c.token),
      ],
    ]);
    // No link and no code went to the claimant's address.
    seen.mailed = String(mail.filter((m) => m.to === "mallory@evil.example").length);
    return seen;
  },
  want: () => ({ link: DEAD, code: DEAD, mailed: "0" }),
};

const OAUTH_AUTHORIZE: Flow = {
  name: "the OAuth authorize",
  setup: async (w) => ({ clientId: await oauthClient(w) }),
  act: async (w, c, ctx) => {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: ctx.clientId ?? "",
      redirect_uri: REDIRECT,
      code_challenge: await sha256Base64Url("v".repeat(43)),
      code_challenge_method: "S256",
      scope: "openid email mcp:read offline_access",
      resource: RESOURCE,
      state: "st-1",
      nonce: "n-1",
    });
    const res = await call(w, get(`/oauth/authorize?${query}`, c.token));
    const location = new URL(res.headers.get("location") ?? `${REDIRECT}?none=1`);
    const held = await env.DB.prepare(
      "SELECT data FROM ta_verification WHERE purpose = 'oauth-request'",
    ).all<{ data: string }>();
    return {
      authorize: String(res.status),
      // With no session, the authorize sends the person to sign in, not to the client.
      client: String(location.href.startsWith(REDIRECT)),
      code: String(location.searchParams.has("code")),
      // It holds the request for the sign-in page, as for any visitor: the row names no user.
      held: held.results
        .map((r) => String((JSON.parse(r.data) as { userId?: unknown }).userId))
        .join(),
    };
  },
  want: () => ({ authorize: "302", client: "false", code: "false", held: "null" }),
  visitor: "oauth-request",
};

const DEVICE_APPROVAL: Flow = {
  name: "the OAuth device approval",
  setup: async (w) => {
    const clientId = await oauthClient(w);
    const started = await call(
      w,
      form("/oauth/device_authorization", {
        client_id: clientId,
        scope: "mcp:read",
        resource: RESOURCE,
      }),
    );
    expect(started.status).toBe(200);
    const body = (await started.json()) as { user_code: string; device_code: string };
    return { clientId, userCode: body.user_code, deviceCode: body.device_code };
  },
  act: (w, c, ctx) =>
    each(w, [
      ["page", form("/oauth/device", { user_code: ctx.userCode ?? "" }, c.token)],
      [
        "allow",
        form("/oauth/device", { user_code: ctx.userCode ?? "", decision: "allow" }, c.token),
      ],
    ]),
  want: () => ({ page: DEAD, allow: DEAD }),
  // The poll after the claim finds no approval.
  later: async (w, _c, ctx) =>
    answer(
      await call(
        w,
        form("/oauth/token", {
          grant_type: DEVICE_GRANT,
          device_code: ctx.deviceCode ?? "",
          client_id: ctx.clientId ?? "",
        }),
      ),
    ),
};

const PASSKEY_REGISTRATION: Flow = {
  name: "the passkey registration",
  act: (w, c) =>
    each(w, [
      ["options", post("/passkey/register/options", {}, c.token)],
      [
        "verify",
        post(
          "/passkey/register/verify",
          { response: { id: "x", response: { clientDataJSON: "e30" } } },
          c.token,
        ),
      ],
    ]),
  want: () => ({ options: DEAD, verify: DEAD }),
};

const SECOND_FACTOR: Flow = {
  name: "the TOTP and second factor",
  act: (w, c) =>
    each(w, [
      ["totp setup", post("/totp/setup", { password: OLD }, c.token)],
      ["totp enable", post("/totp/enable", { code: "123456" }, c.token)],
      ["email method", post("/second-factor/email/enable", { password: OLD }, c.token)],
      [
        "passkey method",
        post("/second-factor/passkey/enable", { password: OLD, response: { id: "x" } }, c.token),
      ],
    ]),
  // The door comes before the password check, also after the verify link that keeps the password.
  want: () => ({
    "totp setup": DEAD,
    "totp enable": DEAD,
    "email method": DEAD,
    "passkey method": DEAD,
  }),
};

const ORGANIZATION_TOKEN: Flow = {
  name: "the organization token create",
  setup: async (w) => acme(w),
  act: (w, c, ctx) =>
    each(w, [
      [
        "create",
        post(
          "/organizations/tokens",
          { organizationId: ctx.organizationId, name: "ci", permissions: {} },
          c.token,
        ),
      ],
    ]),
  want: () => ({ create: DEAD }),
};

const USERNAME: Flow = {
  name: "the username set",
  act: (w, c) => each(w, [["set", post("/user/username", { username: "mallory" }, c.token)]]),
  want: () => ({ set: DEAD }),
};

const PHONE_ADD: Flow = {
  name: "the phone add",
  act: async (w, c) => {
    const seen = await each(w, [
      ["add", post("/phone/add", { phone: PHONE }, c.token)],
      ["verify", post("/phone/add/verify", { code: "123456" }, c.token)],
    ]);
    seen.sent = String(sms.sent.length);
    return seen;
  },
  want: () => ({ add: DEAD, verify: DEAD, sent: "0" }),
};

const TEAM_CREATE: Flow = {
  name: "the team create",
  setup: async (w) => acme(w),
  act: (w, c, ctx) =>
    each(w, [
      [
        "create",
        post(
          "/organizations/teams/create",
          { organizationId: ctx.organizationId, name: "Mallory" },
          c.token,
        ),
      ],
    ]),
  want: () => ({ create: DEAD }),
};

const INVITATION_ACCEPT: Flow = {
  name: "the invitation accept",
  // The owner of acme invites the claimed address before the race.
  setup: async (w) => {
    const org = await acme(w);
    const invited = await call(
      w,
      post(
        "/organizations/invite",
        { organizationId: org.organizationId, email: CLAIMED, role: "member" },
        org.boss,
      ),
    );
    expect(await answer(invited)).toBe("200 ok");
    // The default link is the app's root with `?invitation=<token>`.
    const text = mail.findLast((m) => m.to === CLAIMED && /invited/.test(m.subject))?.text ?? "";
    const token = decodeURIComponent(/invitation=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    expect(token).not.toBe("");
    return { ...org, invitation: token };
  },
  act: (w, c, ctx) =>
    each(w, [
      ["accept", post("/organizations/invitations/accept", { token: ctx.invitation }, c.token)],
    ]),
  want: () => ({ accept: DEAD }),
};

const MEMBER_ADD: Flow = {
  name: "the member add",
  setup: async (w) => acme(w),
  act: (w, c, ctx) =>
    each(w, [
      [
        "add",
        post(
          "/organizations/members/add",
          { organizationId: ctx.organizationId, userId: ctx.carol, role: "member" },
          c.token,
        ),
      ],
    ]),
  want: () => ({ add: DEAD }),
};

/**
 * One run of a scene from an empty database. With `fire`, the claimant's
 * requests run once, right after the claim's flip. The claimant's world
 * sends them on the binding with no count, as another invocation does.
 */
async function run(flow: Flow, proof: Proof, hook: boolean, fire: boolean) {
  await clear();
  const other = make({ counted: false, hook });
  const c = await claimant(other);
  const ctx = flow.setup ? await flow.setup(other, c) : {};
  const request = await proof.prepare(other, c);
  let stage: "armed" | "done" = "armed";
  let answers: Record<string, string> | null = null;
  let window: { verified: number; sessions: { id: string; proved: number }[] } | null = null;
  const owner = make({
    counted: true,
    hook,
    after: async (sql) => {
      if (!fire || stage !== "armed" || !FLIP.test(sql)) return;
      stage = "done";
      // The window: the user reads as verified, and the claimant's sessions are still live.
      const user = await env.DB.prepare("SELECT email_verified AS v FROM ta_user WHERE id = ?")
        .bind(c.id)
        .first<{ v: number }>();
      window = { verified: user?.v ?? -1, sessions: await sessionsOf(c.id) };
      answers = await flow.act(other, c, ctx);
    },
  });
  const proved = await measure(owner, request);
  const later = flow.later ? await flow.later(other, c, ctx) : null;
  const sessions = await sessionsOf(c.id);
  return {
    owner: await answer(proved.res),
    queries: proved.queries,
    stage,
    answers,
    window,
    later,
    claimant: c,
    // The claim leaves one session of the user: the owner's, made after the proof.
    ownerSessions: sessions.map((s) => ({ claimant: c.sessions.includes(s.id), proved: s.proved })),
    endings: [...endings].sort(),
    tables: await everyTable(),
  };
}

/** The tables with no verification row of the purpose `visitor`. */
function withoutVisitor(tables: Awaited<ReturnType<typeof everyTable>>, visitor?: string) {
  if (visitor === undefined) return tables;
  const purposes = tables.purposes.filter((p) => p !== visitor);
  const counts = { ...tables.counts };
  counts.ta_verification =
    (counts.ta_verification ?? 0) - (tables.purposes.length - purposes.length);
  return { ...tables, counts, purposes };
}

/** The checks of one scene: the control run, then the run with the claimant's requests at the flip. */
async function holds(flow: Flow, proof: Proof, hook: boolean) {
  const control = await run(flow, proof, hook, false);
  const raced = await run(flow, proof, hook, true);
  expect(control.answers).toBeNull();
  expect(raced.stage).toBe("done");
  // First the action: its refusal, and every table as the claim alone left it.
  // A row that any visitor's request holds, which names no user, stays out.
  expect(raced.answers).toEqual(flow.want());
  expect(withoutVisitor(raced.tables, flow.visitor)).toEqual(control.tables);
  expect(raced.later).toBe(control.later);
  // At the flip the user reads as verified, and both claimant sessions are live and unproved.
  expect(raced.window).toEqual({
    verified: 1,
    sessions: raced.claimant.sessions
      .slice()
      .sort()
      .map((id) => ({ id, proved: 0 })),
  });
  for (const r of [control, raced]) {
    // The claim completed: the owner's proof answers, and the owner holds one proved session.
    expect(r.owner).toBe("200 ok");
    expect(r.queries).toBeLessThanOrEqual(BUDGET);
    expect(r.ownerSessions).toEqual([{ claimant: false, proved: 1 }]);
    expect(r.tables.user).toEqual({ verified: 1, username: null, phone: null });
  }
  // The hook fires afterEnd once for each claimant session. The claim ends each
  // with the reason claim. In the raced run, the door ended the session that
  // acted first, with the reason claimed (ruling 13 of plan 12q).
  expect(control.endings).toEqual(
    hook ? control.claimant.sessions.map((id) => `claim:${id}`).sort() : [],
  );
  expect(raced.endings).toEqual(
    hook
      ? raced.claimant.sessions
          .map((id) => (id === raced.claimant.actor ? `claimed:${id}` : `claim:${id}`))
          .sort()
      : [],
  );
}

const HOOKS = [true, false] as const;

beforeEach(clear);

describe("a claimant's session at the claim's flip on D1: the three probed flows (plan 12p decision 12)", () => {
  for (const flow of [TOKEN, CHANGE_OF_ADDRESS, OAUTH_AUTHORIZE])
    for (const proof of [MAGIC_LINK, ID_TOKEN, RESET_LINK])
      for (const hook of HOOKS)
        it(`${flow.name} at the flip of ${proof.name} (afterEnd hook ${hook}) answers its refusal and leaves no row`, async () => {
          await holds(flow, proof, hook);
        });
});

describe("a claimant's session at the claim's flip on D1: the six flows by reading (plan 12p decision 12)", () => {
  for (const flow of [
    DEVICE_APPROVAL,
    PASSKEY_REGISTRATION,
    SECOND_FACTOR,
    ORGANIZATION_TOKEN,
    USERNAME,
    PHONE_ADD,
  ])
    for (const hook of HOOKS)
      it(`${flow.name} at the flip of a magic link (afterEnd hook ${hook}) answers its refusal and leaves no row`, async () => {
        await holds(flow, MAGIC_LINK, hook);
      });
  for (const hook of HOOKS)
    it(`the TOTP setup at the flip of the verify link, which keeps the password, answers its refusal and leaves no row (afterEnd hook ${hook})`, async () => {
      await holds(SECOND_FACTOR, VERIFY_LINK, hook);
    });
});

describe("a claimant's session at the claim's flip on D1: three routes of the closed flows (ruling 21 of plan 12p)", () => {
  // Each route passes the session that it holds. With the session dropped,
  // the user row reads as verified at the flip, and the gate would pass.
  for (const flow of [TEAM_CREATE, INVITATION_ACCEPT, MEMBER_ADD])
    for (const hook of HOOKS)
      it(`${flow.name} at the flip of a magic link (afterEnd hook ${hook}) answers its refusal and leaves no row`, async () => {
        await holds(flow, MAGIC_LINK, hook);
      });
});
