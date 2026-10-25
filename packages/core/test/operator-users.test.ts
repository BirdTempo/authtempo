import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmEmailChange, requestEmailChange } from "../src/engine/email-change.js";
import { matchOperatorSecret, type OperatorActor } from "../src/engine/operator/guards.js";
import { operatorApi } from "../src/engine/operator/index.js";
import { addPhone, verifyAddPhone } from "../src/engine/phone.js";
import { createSession } from "../src/engine/sessions.js";
import { setUsername } from "../src/engine/username.js";
import { normalizeEmailPrefix } from "../src/engine/users.js";
import type { OperatorUser } from "../src/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { BASE_URL, makeAuth, seedPlatform, tokenFromMail } from "./helpers.js";
import {
  OPERATOR_SECRETS,
  type OperatorAuth,
  operatorAuth,
  operatorFixture,
  operatorHeader,
} from "./operator-helpers.js";
import { signUpAndVerify } from "./password-helpers.js";
import {
  type FakeIdToken,
  fakeJwt,
  GOOGLE,
  googleSignIn,
  tokenEndpoint,
} from "./social-helpers.js";
import { EMAIL, enrolled, verifiedSession } from "./totp-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const APP: OperatorActor = { kind: "app", name: "support-tool" };

/** The secret actor of a request with the named secret, as the routes build it. */
async function secretActor(auth: OperatorAuth, secret: string): Promise<OperatorActor> {
  const request = new Request(`${BASE_URL}/auth/operator/users`, {
    headers: operatorHeader(secret),
  });
  const entry = await matchOperatorSecret(auth.config, request);
  if (!entry) throw new Error("no secret matched");
  return { kind: "secret", name: entry.name, scopes: entry.scopes };
}

/**
 * Users made through the sign-up and verify flow, in this order. The clock
 * moves 1 ms before each, so the ULID ids sort in the order of creation.
 */
async function signUpAll(auth: OperatorAuth, emails: string[]) {
  const ids: string[] = [];
  for (const email of emails) {
    auth.clock.advance(1);
    const row = await signUpAndVerify(auth, email);
    ids.push(row.userId);
  }
  return ids;
}

describe("operator user reads (plan 12f Task 5)", () => {
  it("lists the users in the order of creation, page by page", async () => {
    const auth = await operatorAuth();
    const api = operatorApi(auth.config);
    const emails = ["g@example.com", "f@example.com", "e@example.com", "d@example.com"];
    emails.push("c@example.com", "b@example.com", "a@example.com");
    const ids = await signUpAll(auth, emails);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await api.users.list({ actor: APP, limit: 3 });
    if (!first.ok) throw new Error(first.code);
    expect(first.value.users.map((u) => u.id)).toEqual(ids.slice(0, 3));
    expect(first.value.users.map((u) => u.email)).toEqual(emails.slice(0, 3));
    expect(first.value.next).toBe(ids[2]);

    const second = await api.users.list({ actor: APP, limit: 3, after: first.value.next ?? "" });
    if (!second.ok) throw new Error(second.code);
    expect(second.value.users.map((u) => u.id)).toEqual(ids.slice(3, 6));
    expect(second.value.next).toBe(ids[5]);

    const third = await api.users.list({ actor: APP, limit: 3, after: second.value.next ?? "" });
    if (!third.ok) throw new Error(third.code);
    expect(third.value.users.map((u) => u.id)).toEqual(ids.slice(6));
    expect(third.value.next).toBeNull();

    // A full page that is the last page answers next null too.
    const all = await api.users.list({ actor: APP, limit: 7 });
    if (!all.ok) throw new Error(all.code);
    expect(all.value.users).toHaveLength(7);
    expect(all.value.next).toBeNull();

    // One log line per read, with the actor and the function, and no address.
    expect(log.mock.calls).toEqual([
      ["authtempo: operator read", "app", "support-tool", "listUsers"],
      ["authtempo: operator read", "app", "support-tool", "listUsers"],
      ["authtempo: operator read", "app", "support-tool", "listUsers"],
      ["authtempo: operator read", "app", "support-tool", "listUsers"],
    ]);
    // A read writes no audit row.
    expect(await auth.storage.findMany("operatorAudit", [])).toEqual([]);

    for (const limit of [0, 101, 1.5]) {
      expect(await api.users.list({ actor: APP, limit })).toMatchObject({ code: "invalid_body" });
    }
    expect(await api.users.list({ actor: APP, after: "" })).toMatchObject({
      code: "invalid_body",
    });
  });

  it("searches by exact address, exact id, and prefix", async () => {
    const auth = await operatorAuth();
    const api = operatorApi(auth.config);
    const [pct, abc, under, abd] = await signUpAll(auth, [
      "a%b@example.com",
      "abc@example.com",
      "a_c@example.com",
      "abd@example.com",
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const emailsOf = async (input: Parameters<typeof api.users.search>[0]) => {
      const r = await api.users.search(input);
      if (!r.ok) throw new Error(r.code);
      return { emails: r.value.users.map((u) => u.email), next: r.value.next };
    };

    // The address rule: trimmed and lowercase.
    expect(await emailsOf({ actor: APP, email: " ABC@Example.com " })).toEqual({
      emails: ["abc@example.com"],
      next: null,
    });
    const byId = await api.users.search({ actor: APP, id: under ?? "" });
    if (!byId.ok) throw new Error(byId.code);
    expect(byId.value.users.map((u) => u.id)).toEqual([under]);

    // `%` and `_` match only themselves, and the prefix is lowercased as an address is.
    expect(await emailsOf({ actor: APP, emailPrefix: "a%b" })).toEqual({
      emails: ["a%b@example.com"],
      next: null,
    });
    expect(await emailsOf({ actor: APP, emailPrefix: "A_C" })).toEqual({
      emails: ["a_c@example.com"],
      next: null,
    });

    // A prefix of three characters matches each address that starts with it.
    const three = await api.users.search({ actor: APP, emailPrefix: "abd" });
    if (!three.ok) throw new Error(three.code);
    expect(three.value.users.map((u) => u.id)).toEqual([abd]);
    const wild = await api.users.search({ actor: APP, emailPrefix: "a%b@" });
    if (!wild.ok) throw new Error(wild.code);
    expect(wild.value.users.map((u) => u.id)).toEqual([pct]);

    // Two keys, no key, a short prefix, a bad address, and a bad id answer invalid_body.
    for (const input of [
      { email: "abc@example.com", id: abc ?? "" },
      { email: "abc@example.com", emailPrefix: "abc" },
      {},
      { emailPrefix: "ab" },
      { emailPrefix: "  a " },
      { emailPrefix: "ab\u0000" },
      { emailPrefix: "ab\ud800" },
      { email: "not an address" },
      { id: "" },
      { id: "x".repeat(65) },
    ]) {
      expect(await api.users.search({ actor: APP, ...input })).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    }
  });

  it("pages a prefix search by address, then id", async () => {
    const auth = await operatorAuth();
    const api = operatorApi(auth.config);
    // Made in an order that is not the address order.
    const ids = await signUpAll(auth, [
      "sam.c@example.com",
      "sam.a@example.com",
      "other@example.com",
      "sam.b@example.com",
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    let after: string | undefined;
    for (const expected of [["sam.a@example.com", "sam.b@example.com"], ["sam.c@example.com"]]) {
      const r = await api.users.search({
        actor: APP,
        emailPrefix: "SAM.",
        limit: 2,
        ...(after === undefined ? {} : { after }),
      });
      if (!r.ok) throw new Error(r.code);
      expect(r.value.users.map((u) => u.email)).toEqual(expected);
      seen.push(...r.value.users.map((u) => u.id));
      after = r.value.next ?? undefined;
    }
    expect(after).toBeUndefined();
    expect(seen).toEqual([ids[1], ids[3], ids[0]]);
    // An `after` that names no user answers invalid_body.
    expect(
      await api.users.search({ actor: APP, emailPrefix: "sam.", after: "01NOSUCHUSER" }),
    ).toMatchObject({ code: "invalid_body" });
  });

  it("refuses a prefix cursor whose address left the prefix (review probe P3)", async () => {
    const auth = await operatorAuth();
    const api = operatorApi(auth.config);
    await signUpAll(auth, ["sam.a@example.com"]);
    const b = await verifiedSession(auth, "sam.b@example.com");
    await signUpAll(auth, ["sam.c@example.com", "sam.d@example.com"]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await api.users.search({ actor: APP, emailPrefix: "sam.", limit: 2 });
    if (!first.ok) throw new Error(first.code);
    expect(first.value.users.map((u) => u.email)).toEqual([
      "sam.a@example.com",
      "sam.b@example.com",
    ]);
    expect(first.value.next).toBe(b.user.id);

    // sam.b moves to an address outside the prefix through the change flow.
    const asked = await requestEmailChange(auth.config, {
      session: b,
      newEmail: "zed@example.com",
    });
    expect(asked.ok).toBe(true);
    const token = tokenFromMail(auth.mail.findLast((m) => m.to === "zed@example.com")?.text ?? "");
    const moved = await confirmEmailChange(auth.config, { token, ip: null, userAgent: null });
    expect(moved.ok).toBe(true);

    // The next page would skip sam.c and sam.d, so the cursor answers invalid_body.
    expect(
      await api.users.search({
        actor: APP,
        emailPrefix: "sam.",
        limit: 2,
        after: first.value.next ?? "",
      }),
    ).toEqual({ ok: false, code: "invalid_body", status: 400 });
  });

  it("answers the same shape for no match", async () => {
    const auth = await operatorAuth();
    const api = operatorApi(auth.config);
    await signUpAll(auth, ["ada@example.com"]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const key of [
      { email: "nobody@example.com" },
      { id: "01NOSUCHUSER" },
      { emailPrefix: "zzz" },
    ]) {
      expect(await api.users.search({ actor: APP, ...key })).toEqual({
        ok: true,
        value: { users: [], next: null },
      });
    }
    expect(await api.users.get({ actor: APP, userId: "01NOSUCHUSER" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("gives no secret, no hash, and no subject", async () => {
    const jwtTokens: Record<string, FakeIdToken> = {};
    const auth = await operatorAuth({
      social: { google: GOOGLE, fetch: tokenEndpoint("idtok-default").fetchFn },
      jwt: fakeJwt(jwtTokens),
    });
    const api = operatorApi(auth.config);
    // A password, then Google by the same verified address, then TOTP.
    const password = await signUpAndVerify(auth, EMAIL);
    await googleSignIn(auth, jwtTokens, { sub: "google-subject-4471" });
    const { user } = await enrolled(auth, EMAIL);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const totp = await auth.storage.findOne("totp", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    const factor = await auth.storage.findOne("secondFactor", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    const sessions = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    const identity = await auth.storage.findOne("identity", [
      { field: "userId", op: "eq", value: user.id },
      { field: "provider", op: "eq", value: "google" },
    ]);
    expect(identity?.subject).toBe("google-subject-4471");
    expect(totp?.secret.length).toBeGreaterThan(20);
    expect(factor?.backupCodes.length).toBeGreaterThan(0);

    const got = await api.users.get({ actor: APP, userId: user.id });
    if (!got.ok) throw new Error(got.code);
    // The core entry names the row type, so an app can type its admin page.
    const row: OperatorUser = got.value;
    expect(row).toEqual({
      id: user.id,
      email: EMAIL,
      emailVerified: true,
      // Plan 12i Task 5: the username and the phone show, null for this user.
      username: null,
      phone: null,
      name: "Ada",
      createdAt: user.createdAt.toISOString(),
      ban: null,
      platformOperator: false,
      secondFactor: ["totp"],
      sessions: sessions.length,
      identities: ["email", "google"],
    });
    expect(sessions.length).toBeGreaterThan(0);

    const listed = await api.users.list({ actor: APP });
    const searched = await api.users.search({ actor: APP, emailPrefix: "ada" });
    for (const answer of [got, listed, searched]) {
      const text = JSON.stringify(answer);
      expect(text).toContain(user.id);
      for (const value of [
        password.hash,
        totp?.secret ?? "missing",
        ...(factor?.backupCodes ?? ["missing"]),
        ...sessions.map((s) => s.tokenHash),
        "google-subject-4471",
      ]) {
        expect(text).not.toContain(value);
      }
    }
  });

  it("marks a platform operator and counts only live sessions", async () => {
    const { auth, root, operator } = await operatorFixture();
    const api = operatorApi(auth.config);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const got = await api.users.get({ actor: APP, userId: operator.user.id });
    if (!got.ok) throw new Error(got.code);
    expect(got.value.platformOperator).toBe(true);
    expect(got.value.sessions).toBeGreaterThan(0);
    const rootRead = await api.users.get({ actor: APP, userId: root.id });
    if (!rootRead.ok) throw new Error(rootRead.code);
    expect(rootRead.value.platformOperator).toBe(true);
    expect(rootRead.value.sessions).toBe(0);
    // Past the expiry of every session, the count is 0.
    auth.clock.advance(400 * 86_400_000);
    const later = await api.users.get({ actor: APP, userId: operator.user.id });
    if (!later.ok) throw new Error(later.code);
    expect(later.value.sessions).toBe(0);
  });

  it("marks a member of the platform organization without the role as no operator", async () => {
    const { auth, operator } = await operatorFixture({ role: "member" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const got = await operatorApi(auth.config).users.get({ actor: APP, userId: operator.user.id });
    if (!got.ok) throw new Error(got.code);
    expect(got.value.platformOperator).toBe(false);
  });

  it("costs the same count of storage calls for a page of 1, 50, and 100 users", async () => {
    const auth = await operatorAuth();
    await seedPlatform(auth);
    for (let i = 0; i < 100; i++) await auth.seedUser(`user${i}@example.com`);
    let calls = 0;
    const counted = new Proxy(auth.storage, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls += 1;
          return value.apply(target, args);
        };
      },
    });
    const api = operatorApi({ ...auth.config, storage: counted });
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const limit of [1, 50, 100]) {
      calls = 0;
      const page = await api.users.list({ actor: APP, limit });
      if (!page.ok) throw new Error(page.code);
      expect(page.value.users).toHaveLength(limit);
      // The user page, the platform organization, and one read each of
      // member, secondFactor, session, and identity.
      expect(calls).toBe(6);
    }
  });

  it("caps the session count at 100", async () => {
    const auth = await operatorAuth();
    const [id] = await signUpAll(auth, ["ada@example.com"]);
    for (let i = 0; i < 101; i++)
      await createSession(auth.config, { userId: id ?? "", ip: null, userAgent: null });
    const live = await auth.storage.findMany("session", [
      { field: "userId", op: "eq", value: id ?? "" },
    ]);
    expect(live.length).toBeGreaterThan(100);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const got = await operatorApi(auth.config).users.get({ actor: APP, userId: id ?? "" });
    if (!got.ok) throw new Error(got.code);
    expect(got.value.sessions).toBe(100);
  });

  it("reads an active ban, and an ended or a lifted ban as no ban (ruling 24)", async () => {
    const auth = await operatorAuth();
    const api = operatorApi(auth.config);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const [id] = await signUpAll(auth, ["ada@example.com"]);
    const userId = id ?? "";
    const banOf = async () => {
      const got = await api.users.get({ actor: APP, userId });
      if (!got.ok) throw new Error(got.code);
      return got.value.ban;
    };
    const act = { actor: APP, userId, reason: "Abuse report 7", ip: null, userAgent: null };
    const bannedAt = auth.clock.now();
    const until = new Date(bannedAt.getTime() + 60 * 60_000);
    expect((await api.users.ban({ ...act, until: until.toISOString() })).ok).toBe(true);
    expect(await banOf()).toEqual({
      at: bannedAt.toISOString(),
      reason: "Abuse report 7",
      until: until.toISOString(),
    });
    auth.clock.advance(61 * 60_000);
    expect(await banOf()).toBeNull();
    expect((await api.users.ban(act)).ok).toBe(true);
    expect(await banOf()).toMatchObject({ until: null });
    auth.clock.advance(60_000);
    expect((await api.users.unban(act)).ok).toBe(true);
    // The unban keeps bannedAt (ruling 28): the read follows activeBan, not the field.
    const row = await auth.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
    expect(row?.bannedAt).not.toBeNull();
    expect(await banOf()).toBeNull();
  });

  it("is off unless operator.users is on", async () => {
    const off = makeAuth();
    const api = operatorApi(off.config);
    const user = await off.seedUser("ada@example.com");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await api.users.list({ actor: APP })).toMatchObject({ code: "not_found" });
    expect(await api.users.search({ actor: APP, email: "ada@example.com" })).toMatchObject({
      code: "not_found",
    });
    expect(await api.users.get({ actor: APP, userId: user.id })).toMatchObject({
      code: "not_found",
    });
    expect(log).not.toHaveBeenCalled();
  });

  describe("refuses an app name outside the rule before the log line (spec 26 item 1)", () => {
    const bad: OperatorActor = { kind: "app", name: "ada@example.com\r\nforged line" };
    const refused = { ok: false, code: "invalid_body", status: 400 };
    const reads = {
      list: (api: ReturnType<typeof operatorApi>) => api.users.list({ actor: bad }),
      search: (api: ReturnType<typeof operatorApi>) =>
        api.users.search({ actor: bad, emailPrefix: "ada" }),
      get: (api: ReturnType<typeof operatorApi>) =>
        api.users.get({ actor: bad, userId: "01NOSUCHUSER" }),
    };
    for (const [name, read] of Object.entries(reads)) {
      it(`users.${name} answers invalid_body and writes no log line, on and off`, async () => {
        const auth = await operatorAuth();
        await signUpAll(auth, ["ada@example.com"]);
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await read(operatorApi(auth.config))).toEqual(refused);
        // With operator.users off, the actor check still comes first.
        expect(await read(operatorApi(makeAuth().config))).toEqual(refused);
        expect(log).not.toHaveBeenCalled();
      });
    }
  });

  it("checks the tool before the scope", async () => {
    // A secret with no scope `users` on an auth with no `operator.users` key.
    const auth = await operatorAuth({
      operator: {
        secrets: [
          {
            name: "keys",
            secretHash: await sha256Hex(OPERATOR_SECRETS.keys),
            scopes: ["keys", "secrets"],
          },
        ],
      },
    });
    const [id] = await signUpAll(auth, ["ada@example.com"]);
    const api = operatorApi(auth.config);
    const actor = await secretActor(auth, OPERATOR_SECRETS.keys);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await api.users.list({ actor })).toMatchObject({ code: "not_found" });
    expect(await api.users.search({ actor, email: "ada@example.com" })).toMatchObject({
      code: "not_found",
    });
    expect(await api.users.get({ actor, userId: id ?? "" })).toMatchObject({
      code: "not_found",
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses a secret without the users scope", async () => {
    const auth = await operatorAuth();
    const api = operatorApi(auth.config);
    const [id] = await signUpAll(auth, ["ada@example.com"]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const secret of [OPERATOR_SECRETS.keys, OPERATOR_SECRETS.audit]) {
      const actor = await secretActor(auth, secret);
      expect(await api.users.list({ actor })).toMatchObject({ code: "operator_required" });
      expect(await api.users.search({ actor, email: "ada@example.com" })).toMatchObject({
        code: "operator_required",
      });
      expect(await api.users.get({ actor, userId: id ?? "" })).toMatchObject({
        code: "operator_required",
      });
    }
    expect(log).not.toHaveBeenCalled();
    // The support secret holds the scope `users`.
    const support = await secretActor(auth, OPERATOR_SECRETS.support);
    const got = await api.users.get({ actor: support, userId: id ?? "" });
    expect(got.ok).toBe(true);
    expect(log.mock.calls).toEqual([["authtempo: operator read", "secret", "support", "getUser"]]);
  });

  it("shows the username and the phone of a user (plan 12i Task 5)", async () => {
    const sms = createRecordingSms();
    const auth = await operatorAuth({
      username: {},
      phone: { sms, regions: ["+1"], isolateLimiter: "allow" },
    });
    const me = await verifiedSession(auth, EMAIL);
    expect(
      (await setUsername(auth.config, { session: me, username: "Ada", ip: null, userAgent: null }))
        .ok,
    ).toBe(true);
    expect((await addPhone(auth.config, { session: me, phone: "+14155550100", ip: null })).ok).toBe(
      true,
    );
    const code = /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
    expect(
      (await verifyAddPhone(auth.config, { session: me, code, ip: null, userAgent: null })).ok,
    ).toBe(true);
    const api = operatorApi(auth.config);
    const got = await api.users.get({ actor: APP, userId: me.user.id });
    expect(got).toMatchObject({ ok: true, value: { username: "ada", phone: "+14155550100" } });
    const listed = await api.users.list({ actor: APP });
    if (!listed.ok) throw new Error(listed.code);
    expect(listed.value.users.find((u) => u.id === me.user.id)).toMatchObject({
      username: "ada",
      phone: "+14155550100",
    });
  });
});

describe("normalizeEmailPrefix", () => {
  it("applies the address steps with no shape check", () => {
    expect(normalizeEmailPrefix("  Ada.L ")).toBe("ada.l");
    expect(normalizeEmailPrefix("a%B_")).toBe("a%b_");
    expect(normalizeEmailPrefix("   ")).toBeNull();
    expect(normalizeEmailPrefix("ad\u0000")).toBeNull();
    expect(normalizeEmailPrefix("ad\u007f")).toBeNull();
    expect(normalizeEmailPrefix("ad\udc00")).toBeNull();
    expect(normalizeEmailPrefix("a".repeat(254))).toBe("a".repeat(254));
    expect(normalizeEmailPrefix("a".repeat(255))).toBeNull();
  });
});
