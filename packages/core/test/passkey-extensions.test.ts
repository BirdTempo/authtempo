import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { createSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { passkeyRoutes } from "../src/http/routes/passkeys.js";
import { toBase64Url } from "../src/primitives/crypto.js";
import { createSimpleWebAuthnSeam, type WebAuthnSeam } from "../src/seams/webauthn.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { APP_ORIGIN, get, makeAuth, post } from "./helpers.js";
import { FAST, pwHandle } from "./password-helpers.js";

/**
 * The passkey extensions PRF, `largeBlob`, and `credProps` (plan 12i Task
 * 21, spec 32 item 21). The client outputs are not signed, so the stored
 * flags are advice, and a PRF output or a large blob never passes the verify.
 */

const RP_ID = "example.com";
const ALL_ON = { prf: true, largeBlob: "preferred", credProps: true } as const;

type Passkey = NonNullable<AuthConfig["passkey"]>;

function rp(extensions?: Passkey["extensions"]): Passkey {
  return {
    rpID: RP_ID,
    rpName: "Example",
    origins: [APP_ORIGIN],
    ...(extensions ? { extensions } : {}),
  };
}

/** A salt of `n` bytes, each byte `fill`, as base64url. */
function salt(n: number, fill = 7): string {
  return toBase64Url(new Uint8Array(n).fill(fill));
}

/** Marks that a PRF output or a large blob must never pass the verify. */
const PRF_AT_REGISTER = salt(32, 0xa1);
const BLOB_AT_REGISTER = toBase64Url(new TextEncoder().encode("blob-at-register-secret"));
const PRF_FIRST = salt(32, 0xb2);
const PRF_SECOND = salt(32, 0xc3);
const BLOB_AT_SIGN_IN = toBase64Url(new TextEncoder().encode("blob-at-sign-in-secret"));
/** Outputs that core does not name: only the kept booleans pass, so these never pass either. */
const EXTRA_OUTPUT = "extra-output-of-credprops";
const UNKNOWN_OUTPUT = "output-of-an-unknown-extension";
const SECRETS = [
  PRF_AT_REGISTER,
  BLOB_AT_REGISTER,
  PRF_FIRST,
  PRF_SECOND,
  BLOB_AT_SIGN_IN,
  EXTRA_OUTPUT,
  UNKNOWN_OUTPUT,
];

/** A WebAuthn seam that records the JSON of each input it gets. */
function recordingSeam(): WebAuthnSeam & { seen: string[] } {
  const real = createSimpleWebAuthnSeam();
  const seen: string[] = [];
  return {
    seen,
    registrationOptions: (i) => real.registrationOptions(i),
    authenticationOptions: (i) => real.authenticationOptions(i),
    verifyRegistration(i) {
      seen.push(JSON.stringify(i));
      return real.verifyRegistration(i);
    },
    verifyAuthentication(i) {
      seen.push(JSON.stringify(i));
      return real.verifyAuthentication(i);
    },
  };
}

async function world(passkey: Passkey, webauthn?: WebAuthnSeam) {
  const auth = makeAuth({
    passkey,
    trustedOrigins: passkey.origins,
    ...(webauthn ? { webauthn } : {}),
  });
  const handle = createRouter(auth.config, passkeyRoutes(auth.config));
  const user = await auth.seedUser("ada@example.com");
  const { token } = await createSession(auth.config, {
    userId: user.id,
    ip: null,
    userAgent: null,
  });
  return { auth, handle, user, cookie: `__Host-tempo_session=${token}` };
}

type World = Awaited<ReturnType<typeof world>>;

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Registers a soft authenticator that answers `outputs` as its client extension outputs. */
async function register(
  w: World,
  outputs: Record<string, unknown> = {},
): Promise<{ soft: SoftAuthenticator; answer: Response }> {
  const soft = await SoftAuthenticator.create({ rpID: RP_ID, origin: APP_ORIGIN });
  const options = await w.handle(post("/auth/passkey/register/options", {}, { cookie: w.cookie }));
  const { challenge } = (await options.json()) as { challenge: string };
  const response = { ...(await soft.register(challenge)), clientExtensionResults: outputs };
  const answer = await w.handle(
    post("/auth/passkey/register/verify", { response }, { cookie: w.cookie }),
  );
  return { soft, answer };
}

/** A sign-in whose assertion carries `outputs` as its client extension outputs. */
async function signIn(
  w: World,
  soft: SoftAuthenticator,
  outputs: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
): Promise<Response> {
  const options = await w.handle(post("/auth/passkey/authenticate/options", body));
  expect(options.status).toBe(200);
  const { challenge } = (await options.json()) as { challenge: string };
  const response = { ...(await soft.authenticate(challenge)), clientExtensionResults: outputs };
  return w.handle(post("/auth/passkey/authenticate/verify", { response }));
}

async function onlyPasskey(w: World) {
  const rows = await w.auth.storage.findMany("passkey", []);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error("no passkey row");
  return row;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the passkey extensions (plan 12i Task 21)", () => {
  it("asks for each configured extension at registration", async () => {
    const on = await world(rp(ALL_ON));
    const res = await on.handle(post("/auth/passkey/register/options", {}, { cookie: on.cookie }));
    expect((await json(res)).extensions).toEqual({
      credProps: true,
      prf: {},
      largeBlob: { support: "preferred" },
    });
    const required = await world(rp({ largeBlob: "required" }));
    const r = await required.handle(
      post("/auth/passkey/register/options", {}, { cookie: required.cookie }),
    );
    expect((await json(r)).extensions).toEqual({ largeBlob: { support: "required" } });
    // Each is off by default. The library asks for credProps by itself; core removes it.
    const off = await world(rp());
    const o = await off.handle(post("/auth/passkey/register/options", {}, { cookie: off.cookie }));
    expect(await json(o)).not.toHaveProperty("extensions");
    // The registration body takes no extension: core never sends a large blob to write.
    const refused = await on.handle(
      post(
        "/auth/passkey/register/options",
        { extensions: { largeBlob: { write: "AAAA" } } },
        { cookie: on.cookie },
      ),
    );
    expect(refused.status).toBe(400);
    expect(await json(refused)).toEqual({ error: "invalid_body" });
  });

  it("stores the three flags from the client outputs", async () => {
    const w = await world(rp(ALL_ON));
    const first = await register(w, {
      credProps: { rk: true },
      prf: { enabled: true },
      largeBlob: { supported: true },
    });
    expect(first.answer.status).toBe(200);
    expect(await onlyPasskey(w)).toMatchObject({
      discoverable: true,
      prf: true,
      largeBlob: true,
    });
    // Each flag reads its own output: rk true does not turn prf or largeBlob on.
    const w2 = await world(rp(ALL_ON));
    await register(w2, {
      credProps: { rk: true },
      prf: { enabled: false },
      largeBlob: { supported: false },
    });
    expect(await onlyPasskey(w2)).toMatchObject({
      discoverable: true,
      prf: false,
      largeBlob: false,
    });
    const w3 = await world(rp(ALL_ON));
    await register(w3, { credProps: { rk: false }, prf: { enabled: true } });
    expect(await onlyPasskey(w3)).toMatchObject({
      discoverable: false,
      prf: true,
      largeBlob: false,
    });
    // An output of the wrong shape is no answer.
    const w4 = await world(rp(ALL_ON));
    await register(w4, {
      credProps: { rk: "yes" },
      prf: { enabled: 1 },
      largeBlob: true,
    });
    expect(await onlyPasskey(w4)).toMatchObject({
      discoverable: null,
      prf: false,
      largeBlob: false,
    });
    // A claim of an extension that core did not ask for is not stored.
    const off = await world(rp());
    await register(off, {
      credProps: { rk: true },
      prf: { enabled: true },
      largeBlob: { supported: true },
    });
    expect(await onlyPasskey(off)).toMatchObject({
      discoverable: null,
      prf: false,
      largeBlob: false,
    });
  });

  it("passes PRF salts and a largeBlob read to the authentication options and refuses a bad salt", async () => {
    const w = await world(rp(ALL_ON));
    const res = await w.handle(
      post("/auth/passkey/authenticate/options", {
        extensions: { prf: { first: salt(32, 1), second: salt(32, 2) }, largeBlob: { read: true } },
      }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).extensions).toEqual({
      prf: { eval: { first: salt(32, 1), second: salt(32, 2) } },
      largeBlob: { read: true },
    });
    const one = await w.handle(
      post("/auth/passkey/authenticate/options", { extensions: { prf: { first: salt(32) } } }),
    );
    expect((await json(one)).extensions).toEqual({ prf: { eval: { first: salt(32) } } });
    // No extension in the body: the options carry none.
    const none = await w.handle(post("/auth/passkey/authenticate/options", {}));
    expect(await json(none)).not.toHaveProperty("extensions");
    for (const extensions of [
      { prf: { first: salt(31) } },
      { prf: { first: salt(33) } },
      { prf: { first: salt(32), second: salt(31) } },
      { prf: { first: `${salt(32).slice(0, 42)}!` } },
      { prf: {} },
      { largeBlob: { read: false } },
      { largeBlob: { write: salt(32) } },
      { credProps: true },
    ]) {
      const bad = await w.handle(post("/auth/passkey/authenticate/options", { extensions }));
      expect({ extensions, status: bad.status, body: await json(bad) }).toEqual({
        extensions,
        status: 400,
        body: { error: "invalid_body" },
      });
    }
    // The api checks the salt too, before the limit counts a try.
    for (const prf of [{ first: salt(31) }, { first: salt(32), second: salt(31) }]) {
      const api = await passkeyAuthenticationOptions(w.auth.config, {
        ip: null,
        extensions: { prf },
      });
      expect({ prf, api }).toMatchObject({ prf, api: { ok: false, code: "invalid_body" } });
    }
    // More bad salts than the limit (30) from one IP: none counts, so a good request passes.
    const ip = "203.0.113.21";
    const good = { prf: { first: salt(32) } };
    for (let i = 0; i < 35; i++) {
      const bad = await passkeyAuthenticationOptions(w.auth.config, {
        ip,
        extensions: { prf: { first: salt(31) } },
      });
      expect(bad).toMatchObject({ ok: false, code: "invalid_body" });
    }
    for (let i = 0; i < 30; i++) {
      const pass = await passkeyAuthenticationOptions(w.auth.config, { ip, extensions: good });
      expect({ i, ok: pass.ok }).toEqual({ i, ok: true });
    }
    // The limit is live for this IP: the 31st good request is refused.
    expect(
      await passkeyAuthenticationOptions(w.auth.config, { ip, extensions: good }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    // An extension that the config does not turn on is refused.
    const off = await world(rp({ credProps: true }));
    for (const extensions of [{ prf: { first: salt(32) } }, { largeBlob: { read: true } }]) {
      const bad = await off.handle(post("/auth/passkey/authenticate/options", { extensions }));
      expect({ extensions, status: bad.status }).toEqual({ extensions, status: 400 });
    }
  });

  it("drops prf.results and largeBlob.blob before any read", async () => {
    const seam = recordingSeam();
    const w = await world(rp(ALL_ON), seam);
    const writes: string[] = [];
    for (const method of ["create", "createMany", "update"] as const) {
      const real = w.auth.storage[method].bind(w.auth.storage) as (...a: unknown[]) => unknown;
      vi.spyOn(w.auth.storage, method).mockImplementation(((...args: unknown[]) => {
        writes.push(JSON.stringify(args));
        return real(...args);
      }) as never);
    }
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });
    const answers: string[] = [];
    const { soft, answer } = await register(w, {
      credProps: { rk: true, note: EXTRA_OUTPUT },
      prf: { enabled: true, results: { first: PRF_AT_REGISTER } },
      largeBlob: { supported: true, blob: BLOB_AT_REGISTER },
      hmacGetSecret: { output1: UNKNOWN_OUTPUT },
    });
    expect(answer.status).toBe(200);
    answers.push(await answer.text());
    const res = await signIn(
      w,
      soft,
      {
        prf: { results: { first: PRF_FIRST, second: PRF_SECOND } },
        largeBlob: { blob: BLOB_AT_SIGN_IN },
      },
      { extensions: { prf: { first: salt(32), second: salt(32, 9) }, largeBlob: { read: true } } },
    );
    expect(res.status).toBe(200);
    answers.push(await res.text());
    await w.auth.config.observe.flush();
    // The seam got the responses, without the two outputs.
    expect(seam.seen).toHaveLength(2);
    expect(seam.seen.join("\n")).toContain('"clientExtensionResults"');
    const all = { seam: seam.seen, writes, lines, answers };
    for (const secret of SECRETS)
      for (const [where, texts] of Object.entries(all))
        expect({ where, holds: texts.some((t) => t.includes(secret)) }).toEqual({
          where,
          holds: false,
        });
    // The flags of the registration are stored; the sign-in outputs change no flag.
    expect(await onlyPasskey(w)).toMatchObject({ discoverable: true, prf: true, largeBlob: true });
  });

  it("decides nothing on the flags", async () => {
    const w = await world(rp(ALL_ON));
    // A browser that answers no output: the flags stay null and false.
    const { soft } = await register(w);
    expect(await onlyPasskey(w)).toMatchObject({
      discoverable: null,
      prf: false,
      largeBlob: false,
    });
    // The passkey signs in as before, with and without a PRF request.
    expect((await signIn(w, soft)).status).toBe(200);
    const withPrf = await signIn(
      w,
      soft,
      { prf: { enabled: true }, largeBlob: { supported: true } },
      { extensions: { prf: { first: salt(32) } } },
    );
    expect(withPrf.status).toBe(200);
    // A claim at the sign-in changes no stored flag.
    expect(await onlyPasskey(w)).toMatchObject({
      discoverable: null,
      prf: false,
      largeBlob: false,
    });
    // A bad signature fails whatever the outputs claim.
    const options = await w.handle(post("/auth/passkey/authenticate/options", {}));
    const { challenge } = (await options.json()) as { challenge: string };
    const assertion = await soft.authenticate(challenge);
    const forged = {
      ...assertion,
      clientExtensionResults: { prf: { enabled: true }, credProps: { rk: true } },
      response: { ...assertion.response, signature: salt(70) },
    };
    const res = await w.handle(post("/auth/passkey/authenticate/verify", { response: forged }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "passkey_failed" });
  });

  it("answers the flags on the passkey list", async () => {
    const w = await world(rp(ALL_ON));
    await register(w, { credProps: { rk: true }, prf: { enabled: true } });
    const res = await w.handle(get("/auth/passkeys", { cookie: w.cookie }));
    expect(res.status).toBe(200);
    const { passkeys } = (await res.json()) as { passkeys: Record<string, unknown>[] };
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0]).toMatchObject({ discoverable: true, prf: true, largeBlob: false });
  });

  it("drops both outputs at the enable, the second factor, and the re-authentication", async () => {
    const seam = recordingSeam();
    const h = pwHandle({ hash: FAST }, { passkey: rp(ALL_ON), webauthn: seam });
    const email = "ada@example.com";
    const pw = "correct horse battery";
    const cookieOf = (res: Response) =>
      (res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session=")) ?? "").split(
        ";",
      )[0] ?? "";
    await h.auth.handle(post("/auth/password/sign-up", { email, password: pw }));
    const token = h.mails.findLast((m) => m.to === email)?.token;
    if (!token) throw new Error("no confirm mail");
    await h.auth.handle(post("/auth/password/verify", { token }));
    const signedIn = await h.auth.handle(post("/auth/password/sign-in", { email, password: pw }));
    const cookie = cookieOf(signedIn);
    const user = await h.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
    if (!user) throw new Error("no user");
    const soft = await SoftAuthenticator.create({ rpID: RP_ID, origin: APP_ORIGIN });
    const regOptions = await passkeyRegistrationOptions(h.config, { user });
    if (!regOptions.ok) throw new Error(regOptions.code);
    const registered = await verifyPasskeyRegistration(h.config, {
      user,
      response: await soft.register(regOptions.value.challenge),
    });
    expect(registered.ok).toBe(true);
    const outputs = {
      prf: { enabled: true, results: { first: PRF_FIRST, second: PRF_SECOND } },
      largeBlob: { supported: true, blob: BLOB_AT_SIGN_IN },
    };
    const leaky = async (challenge: string) => ({
      ...(await soft.authenticate(challenge)),
      clientExtensionResults: outputs,
    });
    // The enable of the passkey method takes a sign-in assertion.
    const signInOptions = await passkeyAuthenticationOptions(h.config, { ip: null });
    if (!signInOptions.ok) throw new Error(signInOptions.code);
    const enable = await h.auth.handle(
      post(
        "/auth/second-factor/passkey/enable",
        { password: pw, response: await leaky(signInOptions.value.challenge) },
        { cookie },
      ),
    );
    expect(enable.status).toBe(200);
    // The second factor of a password sign-in.
    const challenged = await h.auth.handle(post("/auth/password/sign-in", { email, password: pw }));
    const { twoFactor } = (await challenged.json()) as { twoFactor: { challenge: string } };
    const factorOptions = await h.auth.handle(
      post("/auth/second-factor/passkey/options", { challenge: twoFactor.challenge }),
    );
    const { challenge: factorChallenge } = (await factorOptions.json()) as { challenge: string };
    const verified = await h.auth.handle(
      post("/auth/totp/verify", {
        challenge: twoFactor.challenge,
        passkey: await leaky(factorChallenge),
      }),
    );
    expect(verified.status).toBe(200);
    // The re-authentication of the new session.
    const session = cookieOf(verified);
    const reauthOptions = await h.auth.handle(
      post("/auth/reauth/passkey/options", {}, { cookie: session }),
    );
    const { challenge: reauthChallenge } = (await reauthOptions.json()) as { challenge: string };
    const reauth = await h.auth.handle(
      post("/auth/reauth", { passkey: await leaky(reauthChallenge) }, { cookie: session }),
    );
    expect(reauth.status).toBe(200);
    // The registration and the three assertions reached the seam, without the outputs.
    expect(seam.seen).toHaveLength(4);
    for (const secret of [PRF_FIRST, PRF_SECOND, BLOB_AT_SIGN_IN])
      expect(seam.seen.some((t) => t.includes(secret))).toBe(false);
  });
});
