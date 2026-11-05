import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { SIGN_UP_PROOF_COOKIE } from "../src/http/cookies.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { SessionRow } from "../src/schema.js";
import { APP_ORIGIN, BASE_URL, makeAuth, post, recordCredential, settled } from "./helpers.js";
import { FAST, pwHandle } from "./password-helpers.js";

// The confirm of a sign-up from another browser (plan 12q Task 1, decisions
// 1 and 2, ruling 11). The sign-up gives a proof: the cookie
// `__Host-tempo_signup`, and `signUpProof` in the body. A confirm that
// carries it keeps the sign-up's password. Any other confirm is a claim: the
// password goes, the clicker gets a proved session, and the answer says
// `passwordKept: false`. The clicker then sets a first password through
// `POST /password/change` with no current password.

const EMAIL = "ada@example.com";
const PW = "correct horse battery";
const FIRST = "the owner's own first password";
const SESSION_COOKIE = "__Host-tempo_session";
const PROOF_RE = /^sp_[A-Za-z0-9_-]{43}$/;

type Handle = (request: Request) => Promise<Response>;
type World = { handle: Handle; storage: ReturnType<typeof pwHandle>["storage"] };

/** One browser: its cookie jar goes with each request, and each answer updates it. */
class Browser {
  readonly jar = new Map<string, string>();
  constructor(private readonly w: World) {}

  private headers(): Record<string, string> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    return cookie ? { cookie } : {};
  }

  /** Applies the Set-Cookie lines of an answer: a value is kept, `Max-Age=0` deletes. */
  take(res: Response): Response {
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || attrs.some((a) => a.trim() === "Max-Age=0")) this.jar.delete(name);
      else this.jar.set(name, recordCredential(value));
    }
    return res;
  }

  async post(path: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
    return this.take(await this.w.handle(post(path, body, { ...this.headers(), ...extra })));
  }

  /** The form post of the confirm page. */
  async form(path: string, body: string): Promise<Response> {
    const req = new Request(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: APP_ORIGIN,
        ...this.headers(),
      },
      body,
    });
    return this.take(await this.w.handle(req));
  }

  /** The row of the browser's session cookie, or null when the browser has none or the row is gone. */
  async session(): Promise<SessionRow | null> {
    const token = this.jar.get(SESSION_COOKIE);
    if (token === undefined) return null;
    return this.w.storage.findOne("session", [
      { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
    ]);
  }
}

/** The token of the last confirm mail to `to`. */
function linkToken(h: ReturnType<typeof pwHandle>, to = EMAIL): string {
  const token = h.mails.findLast((m) => m.to === to && m.subject.startsWith("Confirm"))?.token;
  if (!token) throw new Error(`no confirm mail to ${to}`);
  return token;
}

/** The sign-up code of the last mail to `to`: the default text starts with it. */
function mailCode(h: ReturnType<typeof pwHandle>, to = EMAIL): string {
  const text = h.mails.findLast((m) => m.to === to)?.text ?? "";
  const code = /^(\d{6}) is your /.exec(text)?.[1];
  if (code === undefined) throw new Error(`no code in the mail: ${text}`);
  return recordCredential(code);
}

async function userId(w: World, email = EMAIL): Promise<string> {
  const user = await w.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error(`no user ${email}`);
  return user.id;
}

async function passwordRow(w: World, email = EMAIL) {
  return w.storage.findOne("password", [
    { field: "userId", op: "eq", value: await userId(w, email) },
  ]);
}

/** A password sign-in from a new browser: its status. */
async function signInStatus(w: World, password: string, email = EMAIL): Promise<number> {
  return (await new Browser(w).post("/auth/password/sign-in", { email, password })).status;
}

/**
 * The pwHandle world. Its handle waits for the work after the answer: the
 * rows and the mail of a uniform sign-up or of a code.
 */
function world(password: Parameters<typeof pwHandle>[0], extra: Partial<AuthConfig> = {}) {
  const h = pwHandle(password, extra);
  const handle = async (r: Request) => {
    const after: Promise<unknown>[] = [];
    const res = await h.auth.handle(r, { waitUntil: (p) => void after.push(p) });
    await Promise.all(after);
    return res;
  };
  return { ...h, handle };
}

describe("the confirm from another browser (plan 12q Task 1)", () => {
  it("is a claim: the password goes, the clicker signs in proved, and sets a first password", async () => {
    const w = world({ hash: FAST });
    const a = new Browser(w);
    const b = new Browser(w);
    const up = await a.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    expect(up.status).toBe(200);
    const body = (await up.json()) as { signUpProof: string; token: string };
    expect(body.signUpProof).toMatch(PROOF_RE);
    expect(a.jar.get(SIGN_UP_PROOF_COOKIE)).toBe(body.signUpProof);
    expect(a.jar.get(SESSION_COOKIE)).toBe(body.token);
    // Browser B has no cookie: the mailbox owner on another device.
    const res = await b.form("/auth/password/verify", `token=${linkToken(w)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/?password=set`);
    const signedIn = await b.session();
    expect(signedIn?.proved).toBe(true);
    expect(signedIn?.userId).toBe(await userId(w));
    const user = await w.storage.findOne("user", [{ field: "email", op: "eq", value: EMAIL }]);
    expect(user?.emailVerified).toBe(true);
    expect(await passwordRow(w)).toBeNull();
    // The sign-up's session ended with the claim, and its password opens nothing.
    expect(await a.session()).toBeNull();
    expect(await signInStatus(w, PW)).toBe(401);
    // The first password, with no current password, on the session that the confirm opened.
    const set = await b.post("/auth/password/change", { newPassword: FIRST });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ ok: true });
    expect(await signInStatus(w, FIRST)).toBe(200);
    expect(await signInStatus(w, PW)).toBe(401);
  });

  it("answers passwordKept false to a JSON caller with no proof", async () => {
    const w = world({ hash: FAST });
    await new Browser(w).post("/auth/password/sign-up", { email: EMAIL, password: PW });
    const res = await new Browser(w).post("/auth/password/verify", { token: linkToken(w) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true, passwordKept: false });
    expect(await passwordRow(w)).toBeNull();
  });

  it("keeps the password in the sign-up's own browser, by form and by JSON, and clears the proof", async () => {
    const w = world({ hash: FAST });
    const a = new Browser(w);
    await a.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    const row = await passwordRow(w);
    const res = await a.form("/auth/password/verify", `token=${linkToken(w)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE_URL}/`);
    expect(res.headers.getSetCookie()).toContain(
      `${SIGN_UP_PROOF_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(a.jar.has(SIGN_UP_PROOF_COOKIE)).toBe(false);
    expect((await passwordRow(w))?.id).toBe(row?.id);
    expect((await a.session())?.proved).toBe(true);
    expect(await signInStatus(w, PW)).toBe(200);

    const c = new Browser(w);
    await c.post("/auth/password/sign-up", { email: "cy@example.com", password: PW });
    const js = await c.post("/auth/password/verify", { token: linkToken(w, "cy@example.com") });
    expect(await js.json()).toEqual({ verified: true, passwordKept: true });
    expect(await passwordRow(w, "cy@example.com")).not.toBeNull();
  });

  it("is a claim for a browser that holds the user's session, or a proof of another sign-up, but not the proof", async () => {
    const w = world({ hash: FAST });
    const a = new Browser(w);
    await a.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    // B holds the sign-up's own session, and no proof: the session is no signal.
    const b = new Browser(w);
    b.jar.set(SESSION_COOKIE, a.jar.get(SESSION_COOKIE) ?? "");
    const res = await b.post("/auth/password/verify", { token: linkToken(w) });
    expect(await res.json()).toEqual({ verified: true, passwordKept: false });
    expect(await passwordRow(w)).toBeNull();

    // C holds a session and a proof of its own sign-up of another address.
    const c = new Browser(w);
    await c.post("/auth/password/sign-up", { email: "cy@example.com", password: PW });
    const d = new Browser(w);
    await d.post("/auth/password/sign-up", { email: "di@example.com", password: PW });
    expect(c.jar.has(SIGN_UP_PROOF_COOKIE)).toBe(true);
    const other = await c.post("/auth/password/verify", { token: linkToken(w, "di@example.com") });
    expect(await other.json()).toEqual({ verified: true, passwordKept: false });
    expect(await passwordRow(w, "di@example.com")).toBeNull();
  });

  it("works under the default config, whose sign-up opens no session", async () => {
    const w = world({ hash: FAST, uniformSignUp: true });
    const a = new Browser(w);
    const up = await a.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    const body = (await up.json()) as { sent: true; signUpProof: string };
    expect(Object.keys(body).sort()).toEqual(["sent", "signUpProof"]);
    expect(body.signUpProof).toMatch(PROOF_RE);
    expect(a.jar.has(SESSION_COOKIE)).toBe(false);
    expect(up.headers.getSetCookie()).toEqual([
      `${SIGN_UP_PROOF_COOKIE}=${body.signUpProof}; Path=/; Max-Age=${w.config.magicLink.ttlMinutes * 60}; HttpOnly; Secure; SameSite=Lax`,
    ]);
    // A known address gets the same shape and a proof of the same form.
    const known = await new Browser(w).post("/auth/password/sign-up", {
      email: EMAIL,
      password: PW,
    });
    const knownBody = (await known.json()) as { sent: true; signUpProof: string };
    expect(Object.keys(knownBody).sort()).toEqual(["sent", "signUpProof"]);
    expect(knownBody.signUpProof).toMatch(PROOF_RE);
    expect(knownBody.signUpProof).not.toBe(body.signUpProof);
    expect(known.headers.getSetCookie()).toHaveLength(1);

    const kept = await a.post("/auth/password/verify", { token: linkToken(w) });
    expect(await kept.json()).toEqual({ verified: true, passwordKept: true });
    expect(await signInStatus(w, PW)).toBe(200);

    await new Browser(w).post("/auth/password/sign-up", { email: "cy@example.com", password: PW });
    const claimed = await new Browser(w).post("/auth/password/verify", {
      token: linkToken(w, "cy@example.com"),
    });
    expect(await claimed.json()).toEqual({ verified: true, passwordKept: false });
    expect(await passwordRow(w, "cy@example.com")).toBeNull();
  });
});

describe("the sign-up code with the proof (plan 12q Task 1)", () => {
  it("keeps from the sign-up's browser and from a bearer app with the proof, and deletes elsewhere", async () => {
    const w = world({ hash: FAST, verifyBy: "code" });
    // The browser of the sign-up: the cookie lives as long as the code.
    const a = new Browser(w);
    const up = await a.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    const proof = ((await up.json()) as { signUpProof: string }).signUpProof;
    const ttl = w.config.password?.verifyCode.ttlMinutes ?? 0;
    expect(up.headers.getSetCookie()).toContain(
      `${SIGN_UP_PROOF_COOKIE}=${proof}; Path=/; Max-Age=${ttl * 60}; HttpOnly; Secure; SameSite=Lax`,
    );
    const own = await a.post("/auth/password/verify/code", { email: EMAIL, code: mailCode(w) });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ passwordKept: true });
    expect(a.jar.has(SIGN_UP_PROOF_COOKIE)).toBe(false);
    expect(await passwordRow(w)).not.toBeNull();

    // A bearer app keeps the body's proof and has no cookie jar.
    const appUp = await w.handle(
      post("/auth/password/sign-up", { email: "cy@example.com", password: PW }),
    );
    const appProof = recordCredential(
      ((await appUp.json()) as { signUpProof: string }).signUpProof,
    );
    const bearer = await w.handle(
      post("/auth/password/verify/code", {
        email: "cy@example.com",
        code: mailCode(w, "cy@example.com"),
        signUpProof: appProof,
      }),
    );
    expect(await bearer.json()).toMatchObject({ passwordKept: true });
    expect(await passwordRow(w, "cy@example.com")).not.toBeNull();

    // Another device with neither: the claim.
    await new Browser(w).post("/auth/password/sign-up", { email: "di@example.com", password: PW });
    const other = await new Browser(w).post("/auth/password/verify/code", {
      email: "di@example.com",
      code: mailCode(w, "di@example.com"),
    });
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ passwordKept: false });
    expect(await passwordRow(w, "di@example.com")).toBeNull();
  });

  it("reads the cookie first: a cookie of another sign-up beside the right body proof is a claim", async () => {
    const w = world({ hash: FAST, verifyBy: "code" });
    const up = await w.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
    const proof = recordCredential(((await up.json()) as { signUpProof: string }).signUpProof);
    const c = new Browser(w);
    await c.post("/auth/password/sign-up", { email: "cy@example.com", password: PW });
    const res = await c.post("/auth/password/verify/code", {
      email: EMAIL,
      code: mailCode(w),
      signUpProof: proof,
    });
    expect(await res.json()).toMatchObject({ passwordKept: false });
    expect(await passwordRow(w)).toBeNull();
  });
});

describe("a new link or code keeps the proof hash only with the proof (plan 12q Task 1)", () => {
  it("copies the hash at a resend that carries the proof, and renews the cookie", async () => {
    const w = world({ hash: FAST });
    const a = new Browser(w);
    await a.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    const proof = a.jar.get(SIGN_UP_PROOF_COOKIE);
    const first = linkToken(w);
    const resend = await a.post("/auth/password/verify/resend", { email: EMAIL });
    expect(await resend.json()).toEqual({ sent: true });
    expect(resend.headers.getSetCookie()).toEqual([
      `${SIGN_UP_PROOF_COOKIE}=${proof}; Path=/; Max-Age=${w.config.magicLink.ttlMinutes * 60}; HttpOnly; Secure; SameSite=Lax`,
    ]);
    const second = linkToken(w);
    expect(second).not.toBe(first);
    const res = await a.post("/auth/password/verify", { token: second });
    expect(await res.json()).toEqual({ verified: true, passwordKept: true });
  });

  it("copies the hash for a bearer app that sends the proof in the body", async () => {
    const w = world({ hash: FAST, verifyBy: "code" });
    const up = await w.handle(post("/auth/password/sign-up", { email: EMAIL, password: PW }));
    const proof = recordCredential(((await up.json()) as { signUpProof: string }).signUpProof);
    const resend = await w.handle(
      post("/auth/password/verify/resend", { email: EMAIL, signUpProof: proof }),
    );
    expect(resend.headers.getSetCookie()).toEqual([]);
    const res = await w.handle(
      post("/auth/password/verify/code", { email: EMAIL, code: mailCode(w), signUpProof: proof }),
    );
    expect(await res.json()).toMatchObject({ passwordKept: true });
  });

  it("writes no hash at a resend with no proof, so even the sign-up's browser then claims", async () => {
    const w = world({ hash: FAST });
    const a = new Browser(w);
    await a.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    await new Browser(w).post("/auth/password/verify/resend", { email: EMAIL });
    const res = await a.post("/auth/password/verify", { token: linkToken(w) });
    expect(await res.json()).toEqual({ verified: true, passwordKept: false });
    expect(await passwordRow(w)).toBeNull();
  });

  it("copies nothing for the proof of another sign-up of the same address", async () => {
    // The claimant signs up first. The owner then tries a sign-up of the same
    // address, which gives the owner's browser a proof of its own, and asks
    // for a new link there. That proof must not keep the claimant's password.
    const w = world({ hash: FAST, uniformSignUp: true });
    const claimant = new Browser(w);
    await claimant.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    const owner = new Browser(w);
    await owner.post("/auth/password/sign-up", { email: EMAIL, password: FIRST });
    expect(owner.jar.get(SIGN_UP_PROOF_COOKIE)).toMatch(PROOF_RE);
    await owner.post("/auth/password/verify/resend", { email: EMAIL });
    const res = await owner.post("/auth/password/verify", { token: linkToken(w) });
    expect(await res.json()).toEqual({ verified: true, passwordKept: false });
    expect(await passwordRow(w)).toBeNull();
    expect(await signInStatus(w, PW)).toBe(401);
  });

  it("copies the hash at the new link of an unverified sign-in from the sign-up's browser", async () => {
    const w = world({ hash: FAST, requireVerified: true });
    const a = new Browser(w);
    const up = await a.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    expect(await up.json()).toMatchObject({ verifyRequired: true });
    const first = linkToken(w);
    const signIn = await a.post("/auth/password/sign-in", { email: EMAIL, password: PW });
    expect(await signIn.json()).toEqual({ error: "email_unverified" });
    const second = linkToken(w);
    expect(second).not.toBe(first);
    const res = await a.post("/auth/password/verify", { token: second });
    expect(await res.json()).toEqual({ verified: true, passwordKept: true });
    expect(await signInStatus(w, PW)).toBe(200);
  });

  it("writes no hash at the new link of an unverified sign-in from another browser", async () => {
    const w = world({ hash: FAST, requireVerified: true });
    const a = new Browser(w);
    await a.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    await new Browser(w).post("/auth/password/sign-in", { email: EMAIL, password: PW });
    const res = await a.post("/auth/password/verify", { token: linkToken(w) });
    expect(await res.json()).toEqual({ verified: true, passwordKept: false });
  });
});

describe("the anonymous upgrade and the API forms (plan 12q Task 1)", () => {
  it("keeps the password at an upgrade confirmed in the sign-up's browser", async () => {
    const auth = makeAuth({
      password: { hash: FAST, uniformSignUp: true },
      anonymous: { isolateLimiter: "allow" },
    });
    const handle = settled(createRouter(auth.config, coreRoutes(auth.config)));
    const w: World = { handle, storage: auth.storage };
    const a = new Browser(w);
    expect((await a.post("/auth/anonymous/sign-in", {})).status).toBe(200);
    await a.post("/auth/password/sign-up", { email: EMAIL, password: PW });
    const mail = auth.mail.findLast((m) => m.to === EMAIL)?.text ?? "";
    const token = recordCredential(
      decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail)?.[1] ?? ""),
    );
    const res = await a.post("/auth/password/verify", { token });
    expect(await res.json()).toEqual({ verified: true, passwordKept: true });
    expect(await passwordRow(w)).not.toBeNull();
  });

  it("takes signUpProof in verifyEmail and verifyCode, and keeps only with it", async () => {
    const w = world({ hash: FAST });
    const api = w.auth.api.password;
    if (!api) throw new Error("no password api");
    const up = await api.signUp({ email: EMAIL, password: PW, ip: null, userAgent: null });
    if (!up.ok) throw new Error(up.code);
    const signUpProof = recordCredential(up.value.signUpProof);
    const kept = await api.verifyEmail({
      token: linkToken(w),
      ip: null,
      userAgent: null,
      signUpProof,
    });
    expect(kept.ok && kept.value.passwordKept).toBe(true);
    expect(await passwordRow(w)).not.toBeNull();

    const other = await api.signUp({
      email: "cy@example.com",
      password: PW,
      ip: null,
      userAgent: null,
    });
    if (!other.ok) throw new Error(other.code);
    // The proof of another sign-up, and a malformed one, keep nothing.
    const claimed = await api.verifyEmail({
      token: linkToken(w, "cy@example.com"),
      ip: null,
      userAgent: null,
      signUpProof,
    });
    expect(claimed.ok && claimed.value.passwordKept).toBe(false);
    expect(claimed.ok && claimed.value.signedIn?.session.proved).toBe(true);
    expect(await passwordRow(w, "cy@example.com")).toBeNull();
  });
});

describe("the name of the proof cookie (plan 12q Task 1)", () => {
  it("is refused as the session cookie and as the last method cookie", () => {
    expect(() => makeAuth({ cookieName: SIGN_UP_PROOF_COOKIE })).toThrow(
      "cookieName must not be __Host-tempo_signup: it is the sign-up proof cookie of core",
    );
    expect(() => makeAuth({ lastMethod: { cookieName: SIGN_UP_PROOF_COOKIE } })).toThrow(
      "lastMethod.cookieName must be a cookie name of 1 to 64 token characters",
    );
  });
});
