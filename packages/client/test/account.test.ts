import { createPbkdf2PasswordHash } from "@authtempo/core";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import type { ClientResult } from "../src/result.js";
import type { BrowserWebAuthn } from "../src/webauthn.js";
import { BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const BASE = "https://api.example.com";

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

/** A fetch that answers from a list of responses in order, and records each request. */
function scripted(answers: Response[]) {
  const seen: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const text = await req.text();
    seen.push({
      method: req.method,
      path: new URL(req.url).pathname.replace(/^\/auth/, ""),
      body: text ? JSON.parse(text) : undefined,
    });
    return answers.shift() ?? Response.json({ error: "internal" }, { status: 500 });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}

const notFresh = () => Response.json({ error: "session_not_fresh" }, { status: 403 });

describe("withFresh (plan 12a)", () => {
  it("re-authenticates once on session_not_fresh and sends the change again", async () => {
    const { seen, fetch } = scripted([
      notFresh(),
      Response.json({ freshUntil: "2026-10-15T00:00:00.000Z" }),
      Response.json({ ok: true }),
    ]);
    const c = createClient({ baseURL: BASE, fetch, broadcast: false });
    const r = await c.withFresh(
      () => c.user.delete(),
      () => c.reauth.password({ password: "pw" }),
    );
    expect(r).toEqual({ ok: true, value: { ok: true } });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /user/delete",
      "POST /reauth",
      "POST /user/delete",
    ]);
    expect(seen[1]?.body).toEqual({ password: "pw" });
  });

  it("answers a second session_not_fresh as it is, and a failed re-authentication without a second send", async () => {
    const twice = scripted([notFresh(), Response.json({ freshUntil: "x" }), notFresh()]);
    const c1 = createClient({ baseURL: BASE, fetch: twice.fetch, broadcast: false });
    expect(
      await c1.withFresh(
        () => c1.sessions.revokeOthers(),
        () => c1.reauth.password({ password: "pw" }),
      ),
    ).toMatchObject({ ok: false, code: "session_not_fresh" });
    expect(twice.seen).toHaveLength(3);
    const wrong = scripted([
      notFresh(),
      Response.json({ error: "invalid_credentials" }, { status: 401 }),
    ]);
    const c2 = createClient({ baseURL: BASE, fetch: wrong.fetch, broadcast: false });
    expect(
      await c2.withFresh(
        () => c2.sessions.revokeOthers(),
        () => c2.reauth.password({ password: "nope" }),
      ),
    ).toMatchObject({ ok: false, code: "invalid_credentials" });
    expect(wrong.seen).toHaveLength(2);
  });

  it("runs no re-authentication when the change passes or fails for another reason", async () => {
    let asked = 0;
    const again = async (): Promise<ClientResult<unknown>> => {
      asked += 1;
      return { ok: true, value: {} };
    };
    const passed = scripted([Response.json({ ended: 2 })]);
    const c1 = createClient({ baseURL: BASE, fetch: passed.fetch, broadcast: false });
    expect(await c1.withFresh(() => c1.sessions.revokeOthers(), again)).toEqual({
      ok: true,
      value: { ended: 2 },
    });
    const limited = scripted([Response.json({ error: "rate_limited" }, { status: 429 })]);
    const c2 = createClient({ baseURL: BASE, fetch: limited.fetch, broadcast: false });
    expect(await c2.withFresh(() => c2.sessions.revokeOthers(), again)).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
    expect(asked).toBe(0);
    expect(passed.seen).toHaveLength(1);
    expect(limited.seen).toHaveLength(1);
  });
});

describe("the settings operations (plan 12a)", () => {
  it("links a provider: posts the start, then navigates to the provider", async () => {
    const went: string[] = [];
    const { seen, fetch } = scripted([
      Response.json({ url: "https://accounts.example/authorize?x=1" }),
    ]);
    const c = createClient({
      baseURL: BASE,
      fetch,
      broadcast: false,
      navigate: (u) => went.push(u),
    });
    expect(await c.identities.link({ provider: "google", next: "/settings" })).toEqual({
      ok: true,
      value: { url: "https://accounts.example/authorize?x=1" },
    });
    expect(seen).toEqual([
      { method: "POST", path: "/social/google/link", body: { next: "/settings" } },
    ]);
    expect(went).toEqual(["https://accounts.example/authorize?x=1"]);
    expect(await c.identities.link({ provider: "Not A Name" })).toEqual({
      ok: false,
      code: "invalid_body",
      status: 0,
    });
    expect(seen).toHaveLength(1);
  });

  it("answers unexpected with status 0 for a link when the default navigate finds no location", async () => {
    // No `navigate` option, and the test runtime has no `location`, as in a server render.
    expect((globalThis as { location?: unknown }).location).toBeUndefined();
    const { seen, fetch } = scripted([Response.json({ url: "https://accounts.example/a" })]);
    const c = createClient({ baseURL: BASE, fetch, broadcast: false });
    expect(await c.identities.link({ provider: "google" })).toEqual({
      ok: false,
      code: "unexpected",
      status: 0,
    });
    expect(seen).toHaveLength(1);
  });

  it("re-authenticates by a passkey: the options, the ceremony, and the proof", async () => {
    const { seen, fetch } = scripted([
      Response.json({ challenge: "c" }),
      Response.json({ freshUntil: "2026-10-15T00:00:00.000Z" }),
    ]);
    const webauthn: BrowserWebAuthn = {
      create: async () => ({}) as Awaited<ReturnType<BrowserWebAuthn["create"]>>,
      get: async () => ({ id: "cred" }) as Awaited<ReturnType<BrowserWebAuthn["get"]>>,
    };
    const c = createClient({ baseURL: BASE, fetch, webauthn, broadcast: false });
    expect(await c.reauth.passkey()).toEqual({
      ok: true,
      value: { freshUntil: "2026-10-15T00:00:00.000Z" },
    });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /reauth/passkey/options",
      "POST /reauth",
    ]);
    expect(seen[1]?.body).toEqual({ passkey: { id: "cred" } });
  });

  it("answers the list of sessions and of identities as their JSON", async () => {
    const { fetch } = scripted([
      Response.json({ sessions: [{ id: "s1", current: true }] }),
      Response.json({ identities: [], password: true, passkeys: 1 }),
    ]);
    const c = createClient({ baseURL: BASE, fetch, broadcast: false });
    expect(await c.sessions.list()).toMatchObject({
      ok: true,
      value: [{ id: "s1", current: true }],
    });
    expect(await c.identities.list()).toEqual({
      ok: true,
      value: { identities: [], password: true, passkeys: 1 },
    });
  });

  it("sends each operation's body, with no key for an option that the caller left out", async () => {
    const { seen, fetch } = scripted([
      Response.json({ freshUntil: "f" }),
      Response.json({ sent: true }),
      Response.json({ freshUntil: "f" }),
      Response.json({ ended: 0 }),
      Response.json({ user: { id: "u1", email: "a@b.c" } }),
      Response.json({ user: { id: "u1", email: "a@b.c" } }),
      Response.json({ sent: true }),
      Response.json({ sent: true }),
      Response.json({ user: { id: "u1", email: "n@b.c" } }),
      Response.json({ user: { id: "u1", email: "n@b.c" } }),
      Response.json({ ok: true }),
      Response.json({ ok: true }),
      Response.json({ ok: true }),
      Response.json({ url: "https://accounts.example/a" }),
    ]);
    const c = createClient({ baseURL: BASE, fetch, broadcast: false, navigate: () => {} });
    const all = [
      await c.reauth.password({ password: "pw", code: "123456" }),
      await c.reauth.requestEmailCode(),
      await c.reauth.emailCode({ emailCode: "654321" }),
      await c.sessions.revokeOthers(),
      await c.user.update({ name: null, image: "https://img.example/a.png" }),
      await c.user.update({}),
      await c.user.changeEmail({ newEmail: "n@b.c", method: "code", next: "/settings" }),
      await c.user.changeEmail({ newEmail: "n@b.c" }),
      await c.user.confirmEmailChange({ token: "ec_t" }),
      await c.user.verifyEmailChange({ code: "111222" }),
      await c.user.delete(),
      await c.user.confirmDelete({ token: "ad_t" }),
      await c.identities.unlink({ id: "i1" }),
      await c.identities.link({ provider: "github" }),
    ];
    expect(all.every((r) => r.ok)).toBe(true);
    expect(seen).toEqual([
      { method: "POST", path: "/reauth", body: { password: "pw", code: "123456" } },
      { method: "POST", path: "/reauth/email", body: {} },
      { method: "POST", path: "/reauth", body: { emailCode: "654321" } },
      { method: "POST", path: "/sessions/revoke-others", body: {} },
      {
        method: "POST",
        path: "/user/update",
        body: { name: null, image: "https://img.example/a.png" },
      },
      { method: "POST", path: "/user/update", body: {} },
      {
        method: "POST",
        path: "/user/change-email",
        body: { newEmail: "n@b.c", method: "code", next: "/settings" },
      },
      { method: "POST", path: "/user/change-email", body: { newEmail: "n@b.c" } },
      { method: "POST", path: "/user/change-email/confirm", body: { token: "ec_t" } },
      { method: "POST", path: "/user/change-email/verify", body: { code: "111222" } },
      { method: "POST", path: "/user/delete", body: {} },
      { method: "POST", path: "/user/delete/confirm", body: { token: "ad_t" } },
      { method: "POST", path: "/identities/unlink", body: { id: "i1" } },
      { method: "POST", path: "/social/github/link", body: {} },
    ]);
  });
});

describe("sessions.revoke and the caller's own session (plan 12a)", () => {
  it("sends one revoke, and answers current true from the answer for its own session", async () => {
    const { seen, fetch } = scripted([Response.json({ ok: true, current: true })]);
    const c = createClient({ baseURL: BASE, fetch, broadcast: false });
    expect(await c.sessions.revoke({ id: "s1" })).toEqual({
      ok: true,
      value: { ok: true, current: true },
    });
    expect(seen).toEqual([{ method: "POST", path: "/sessions/revoke", body: { id: "s1" } }]);
  });

  it("answers current false from the answer for another session", async () => {
    const { seen, fetch } = scripted([Response.json({ ok: true, current: false })]);
    const c = createClient({ baseURL: BASE, fetch, broadcast: false });
    expect(await c.sessions.revoke({ id: "s2" })).toEqual({
      ok: true,
      value: { ok: true, current: false },
    });
    expect(seen).toHaveLength(1);
  });

  it("answers the failure of the revoke as it is", async () => {
    const { seen, fetch } = scripted([Response.json({ error: "unauthorized" }, { status: 401 })]);
    const c = createClient({ baseURL: BASE, fetch, broadcast: false });
    expect(await c.sessions.revoke({ id: "s1" })).toEqual({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    expect(seen).toHaveLength(1);
  });

  it("reads the bearer token once per revoke", async () => {
    // Each read answers another token, so a second read would show in the count or the header.
    const tokens = ["tk1", "tk2"];
    let reads = 0;
    const sent: (string | null)[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Request(input, init).headers.get("authorization"));
      return Response.json({ ok: true, current: true });
    }) as typeof globalThis.fetch;
    const c = createClient({
      baseURL: BASE,
      fetch,
      broadcast: false,
      credentials: "omit",
      token: () => tokens[reads++] ?? null,
    });
    expect(await c.sessions.revoke({ id: "s1" })).toEqual({
      ok: true,
      value: { ok: true, current: true },
    });
    expect(reads).toBe(1);
    expect(sent).toEqual(["Bearer tk1"]);
  });
});

/** A fetch that answers 200 with `body` to every request. */
function answering(body: string) {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
}

// Not objects, and objects of another shape (plan 11d rule: a 200 of another shape is `unexpected`).
const NOT_OBJECTS = ["null", "[]", '"x"', "1", "true"];
const UNEXPECTED = { ok: false, code: "unexpected", status: 200 };

describe("the delete's two answers (plan 12a Task 20)", () => {
  it("reads the session again after { ok: true }, and not after { sent: true }", async () => {
    const session = () =>
      Response.json({
        user: { id: "u1", email: "a@b.c" },
        session: { id: "s1", expiresAt: "2026-10-20T00:00:00.000Z" },
      });
    for (const [answer, reads] of [
      [{ sent: true }, 1],
      [{ ok: true }, 2],
    ] as const) {
      const { seen, fetch } = scripted([session(), Response.json(answer), session()]);
      const c = createClient({ baseURL: BASE, fetch, broadcast: false });
      const stop = c.store.subscribe(() => {});
      await vi.waitFor(() => expect(c.store.get().data).not.toBeNull());
      expect(await c.user.delete()).toEqual({ ok: true, value: answer });
      // Let a read that the answer started reach the fetch.
      await new Promise((r) => setTimeout(r, 20));
      const sessionReads = seen.filter((x) => x.path === "/session").length;
      expect(sessionReads, JSON.stringify(answer)).toBe(reads);
      stop();
    }
  });
});

describe("the shape of each 200 answer (plan 12a)", () => {
  type Run = (c: ReturnType<typeof createClient>) => Promise<ClientResult<unknown>>;
  /** Each new operation, with bodies of a wrong shape beside the five that are not objects. */
  const OPERATIONS: [string, Run, string[]][] = [
    [
      "sessions.list",
      (c) => c.sessions.list(),
      ["{}", '{"sessions":"x"}', '{"sessions":[null]}', '{"sessions":[{"id":"s1"}]}'],
    ],
    [
      "sessions.revoke",
      (c) => c.sessions.revoke({ id: "s1" }),
      ["{}", '{"ok":false,"current":true}', '{"ok":true}', '{"ok":true,"current":"yes"}'],
    ],
    ["sessions.revokeOthers", (c) => c.sessions.revokeOthers(), ["{}", '{"ended":"2"}']],
    [
      "passkeys.rename",
      (c) => c.passkeys.rename({ id: "p", name: "Phone" }),
      [
        "{}",
        '{"passkey":null}',
        '{"id":"p","name":"Phone","createdAt":"t"}',
        '{"passkey":{"id":1,"name":"Phone","createdAt":"t"}}',
        '{"passkey":{"id":"p","name":1,"createdAt":"t"}}',
        '{"passkey":{"id":"p","name":"Phone"}}',
      ],
    ],
    ["reauth.password", (c) => c.reauth.password({ password: "p" }), ["{}", '{"freshUntil":1}']],
    ["reauth.requestEmailCode", (c) => c.reauth.requestEmailCode(), ["{}", '{"sent":"yes"}']],
    [
      "reauth.emailCode",
      (c) => c.reauth.emailCode({ emailCode: "1" }),
      ["{}", '{"freshUntil":null}'],
    ],
    ["user.update", (c) => c.user.update({ name: "n" }), ["{}", '{"user":{"id":"u1"}}']],
    ["user.changeEmail", (c) => c.user.changeEmail({ newEmail: "a@b.c" }), ["{}"]],
    [
      "user.confirmEmailChange",
      (c) => c.user.confirmEmailChange({ token: "t" }),
      ["{}", '{"user":null}'],
    ],
    [
      "user.verifyEmailChange",
      (c) => c.user.verifyEmailChange({ code: "1" }),
      ["{}", '{"user":[]}'],
    ],
    ["user.delete", (c) => c.user.delete(), ["{}", '{"ok":1}', '{"sent":1}', '{"sent":false}']],
    [
      "user.confirmDelete",
      (c) => c.user.confirmDelete({ token: "t" }),
      ["{}", '{"ok":1}', '{"sent":true}'],
    ],
    [
      "identities.list",
      (c) => c.identities.list(),
      [
        "{}",
        '{"identities":[],"password":true}',
        '{"identities":[null],"password":true,"passkeys":0}',
        '{"identities":[{"id":"i1"}],"password":true,"passkeys":0}',
      ],
    ],
    ["identities.unlink", (c) => c.identities.unlink({ id: "i1" }), ["{}", '{"ok":"true"}']],
    [
      "identities.link",
      (c) => c.identities.link({ provider: "google" }),
      ["{}", '{"url":1}', '{"url":"javascript:alert(1)"}', '{"url":"not a url"}'],
    ],
  ];

  for (const [name, run, wrong] of OPERATIONS)
    it(`${name}: answers unexpected with status 200 for a 200 of another shape`, async () => {
      for (const body of [...NOT_OBJECTS, ...wrong]) {
        const went: string[] = [];
        const c = createClient({
          baseURL: BASE,
          fetch: answering(body),
          broadcast: false,
          navigate: (u) => went.push(u),
        });
        expect(await run(c), body).toEqual(UNEXPECTED);
        expect(went, body).toEqual([]);
      }
    });

  it("reauth.passkey: answers unexpected for options of another shape, and asks the browser for nothing", async () => {
    let asked = 0;
    const webauthn: BrowserWebAuthn = {
      create: async () => ({}) as Awaited<ReturnType<BrowserWebAuthn["create"]>>,
      get: async () => {
        asked += 1;
        return { id: "cred" } as Awaited<ReturnType<BrowserWebAuthn["get"]>>;
      },
    };
    for (const body of [...NOT_OBJECTS, "{}", '{"challenge":1}']) {
      const c = createClient({ baseURL: BASE, fetch: answering(body), webauthn, broadcast: false });
      expect(await c.reauth.passkey(), body).toEqual(UNEXPECTED);
    }
    expect(asked).toBe(0);
    // Options of the right shape reach the browser; a wrong proof answer is unexpected.
    const { fetch } = scripted([Response.json({ challenge: "c" }), Response.json({ ok: true })]);
    const c = createClient({ baseURL: BASE, fetch, webauthn, broadcast: false });
    expect(await c.reauth.passkey()).toEqual(UNEXPECTED);
    expect(asked).toBe(1);
  });
});

const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const EMAIL = "ada@example.com";
const PW = "correct horse battery";
const MINUTE = 60_000;

/** A verified person signed in in a browser, and a native app of the same person with its token. */
async function signedIn(overrides: Parameters<typeof makeServer>[0] = {}) {
  const server = makeServer({
    password: { hash: FAST },
    session: { freshMinutes: 10 },
    ...overrides,
  });
  const { fetch } = inProcessFetch(server.auth);
  const browser = createClient({ baseURL: BASE_URL, fetch, broadcast: false });
  await browser.password.signUp({ email: EMAIL, password: PW });
  const verified = await browser.password.verifyEmail({
    token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
  });
  if (!verified.ok) throw new Error(verified.code);
  // The native app signs in on its own client: it sends no cookie and keeps the bearer token.
  let token: string | null = null;
  const app = createClient({
    baseURL: BASE_URL,
    fetch: inProcessFetch(server.auth).fetch,
    credentials: "omit",
    token: () => token,
    broadcast: false,
  });
  const native = await app.password.signIn({ email: EMAIL, password: PW });
  if (!native.ok || !("token" in native.value)) throw new Error("no native session");
  token = native.value.token;
  return { server, browser, app };
}

/** The code of the newest mail: "Your code is <code>." */
function codeOf(server: ReturnType<typeof makeServer>): string {
  const m = /Your code is (\S+)\./.exec(server.mail.at(-1)?.text ?? "");
  if (!m?.[1]) throw new Error("no code in mail");
  return m[1];
}

describe("the settings operations against core (plan 12a)", () => {
  it("lists the sessions, refuses a stale revoke, and passes it after withFresh", async () => {
    const { server, browser, app } = await signedIn();
    const listed = await browser.sessions.list();
    if (!listed.ok) throw new Error(listed.code);
    expect(listed.value).toHaveLength(2);
    expect(listed.value.filter((s) => s.current)).toHaveLength(1);
    expect(typeof listed.value[0]?.createdAt).toBe("string");
    server.clock.advance(11 * MINUTE);
    expect(await browser.sessions.revokeOthers()).toEqual({
      ok: false,
      code: "session_not_fresh",
      status: 403,
    });
    const r = await browser.withFresh(
      () => browser.sessions.revokeOthers(),
      () => browser.reauth.password({ password: PW }),
    );
    expect(r).toEqual({ ok: true, value: { ended: 1 } });
    expect(await app.session()).toEqual({ ok: true, value: null });
  });

  it("revokes another session with current false, and its own with current true", async () => {
    const { browser, app } = await signedIn();
    const stop = browser.store.subscribe(() => {});
    await vi.waitFor(() => expect(browser.store.get().data).not.toBeNull());
    const own = await app.session();
    const mine = await browser.session();
    if (!own.ok || !own.value || !mine.ok || !mine.value) throw new Error("no session");
    expect(await browser.sessions.revoke({ id: own.value.session.id })).toEqual({
      ok: true,
      value: { ok: true, current: false },
    });
    expect(await app.session()).toEqual({ ok: true, value: null });
    expect(await browser.sessions.revoke({ id: mine.value.session.id })).toEqual({
      ok: true,
      value: { ok: true, current: true },
    });
    // The store reads again after the revoke, and finds no session.
    await vi.waitFor(() => expect(browser.store.get().data).toBeNull());
    expect(await browser.session()).toEqual({ ok: true, value: null });
    stop();
  });

  it("re-authenticates by an email code", async () => {
    const { server, browser } = await signedIn();
    server.clock.advance(11 * MINUTE);
    expect(await browser.reauth.requestEmailCode()).toEqual({ ok: true, value: { sent: true } });
    const r = await browser.reauth.emailCode({ emailCode: codeOf(server) });
    if (!r.ok) throw new Error(r.code);
    expect(Date.parse(r.value.freshUntil)).toBe(server.clock.now().getTime() + 10 * MINUTE);
  });

  it("updates the profile, and the store reads the new name", async () => {
    const { browser } = await signedIn();
    const stop = browser.store.subscribe(() => {});
    await vi.waitFor(() => expect(browser.store.get().data?.user.name).toBeNull());
    const r = await browser.user.update({ name: "Ada" });
    expect(r).toMatchObject({ ok: true, value: { user: { email: EMAIL, name: "Ada" } } });
    await vi.waitFor(() => expect(browser.store.get().data?.user.name).toBe("Ada"));
    stop();
  });

  it("changes the address by a mailed link token, and by a mailed code", async () => {
    const { server, browser } = await signedIn();
    const stop = browser.store.subscribe(() => {});
    await vi.waitFor(() => expect(browser.store.get().data?.user.email).toBe(EMAIL));
    expect(await browser.user.changeEmail({ newEmail: "ada@new.example" })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const byLink = await browser.user.confirmEmailChange({
      token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
    });
    expect(byLink).toMatchObject({ ok: true, value: { user: { email: "ada@new.example" } } });
    await vi.waitFor(() => expect(browser.store.get().data?.user.email).toBe("ada@new.example"));
    expect(
      await browser.user.changeEmail({ newEmail: "ada@code.example", method: "code" }),
    ).toEqual({ ok: true, value: { sent: true } });
    const byCode = await browser.user.verifyEmailChange({ code: codeOf(server) });
    expect(byCode).toMatchObject({ ok: true, value: { user: { email: "ada@code.example" } } });
    await vi.waitFor(() => expect(browser.store.get().data?.user.email).toBe("ada@code.example"));
    stop();
  });

  it("lists the identities, refuses the unlink of the email identity, and deletes the account", async () => {
    const { server, browser, app } = await signedIn();
    const stop = browser.store.subscribe(() => {});
    await vi.waitFor(() => expect(browser.store.get().data).not.toBeNull());
    const listed = await browser.identities.list();
    expect(listed).toMatchObject({
      ok: true,
      value: {
        identities: [{ provider: "email", email: EMAIL, canUnlink: false }],
        password: true,
      },
    });
    if (!listed.ok) throw new Error(listed.code);
    expect(typeof listed.value.identities[0]?.linkedAt).toBe("string");
    expect(await browser.identities.unlink({ id: listed.value.identities[0]?.id ?? "" })).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
    server.clock.advance(11 * MINUTE);
    const deleted = await browser.withFresh(
      () => browser.user.delete(),
      () => browser.reauth.password({ password: PW }),
    );
    expect(deleted).toEqual({ ok: true, value: { ok: true } });
    await vi.waitFor(() => expect(browser.store.get().data).toBeNull());
    stop();
    expect(await browser.session()).toEqual({ ok: true, value: null });
    expect(await app.session()).toEqual({ ok: true, value: null });
  });

  it("answers { sent: true } to the delete with account.deleteConfirm on, and deletes at confirmDelete (plan 12a Task 20)", async () => {
    const { server, browser, app } = await signedIn({ account: { deleteConfirm: {} } });
    const stop = browser.store.subscribe(() => {});
    await vi.waitFor(() => expect(browser.store.get().data).not.toBeNull());
    expect(await browser.user.delete()).toEqual({ ok: true, value: { sent: true } });
    // Nothing is deleted yet: the session stays in the store.
    expect(await browser.session()).toMatchObject({ ok: true, value: { user: { email: EMAIL } } });
    const token = tokenFromMail(server.mail.at(-1)?.text ?? "");
    expect(token.startsWith("ad_")).toBe(true);
    // The native app's session is of the same user, and need not be fresh.
    server.clock.advance(11 * MINUTE);
    expect(await app.user.confirmDelete({ token })).toEqual({ ok: true, value: { ok: true } });
    expect(await app.session()).toEqual({ ok: true, value: null });
    expect(await browser.session()).toEqual({ ok: true, value: null });
    stop();
  });
});
