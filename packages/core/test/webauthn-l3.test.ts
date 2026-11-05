import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import {
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
} from "../src/engine/passkeys.js";
import { updateProfile } from "../src/engine/profile.js";
import { createSession, resolveSession } from "../src/engine/sessions.js";
import { createRouter } from "../src/http/router.js";
import { passkeyRoutes } from "../src/http/routes/passkeys.js";
import { onDomainTree } from "../src/primitives/host.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";
import { APP_ORIGIN, get, makeAuth, post, sessionFor } from "./helpers.js";
import { FAST, proofCookie, pwHandle } from "./password-helpers.js";

/**
 * WebAuthn Level 3 (plan 12i Task 9, spec 32 item 3): the related origins
 * document, the hints, and the inputs of the Signal API.
 */

const RP_ID = "example.com";
const SHOP = "https://shop.example.net";
const EVIL = "https://evil.example.org";
const RELATED = {
  rpID: RP_ID,
  rpName: "Example",
  origins: [APP_ORIGIN, SHOP],
  relatedOrigins: true,
};

/** createAuth with `passkey`; the passkey origins are trusted origins. */
function authWith(
  passkey: NonNullable<AuthConfig["passkey"]>,
  baseURL = "https://api.example.com",
) {
  return createAuth({
    baseURL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: passkey.origins.filter((o) => o !== baseURL),
    storage: createMemoryAdapter(),
    mail: { send: async () => {} },
    passkey,
  });
}

/** The resolved config of the test helpers, a router of the passkey routes, and a fresh session cookie. */
async function passkeyWorld(passkey: NonNullable<AuthConfig["passkey"]>) {
  const auth = makeAuth({ passkey, trustedOrigins: passkey.origins });
  const handle = createRouter(auth.config, passkeyRoutes(auth.config));
  const user = await auth.seedUser("ada@example.com");
  const { token } = await createSession(auth.config, {
    userId: user.id,
    ip: null,
    userAgent: null,
    proved: true,
  });
  return { auth, handle, user, cookie: `__Host-tempo_session=${token}` };
}

type World = Awaited<ReturnType<typeof passkeyWorld>>;

/** Registers a soft authenticator through the routes. */
async function register(w: World, origin = APP_ORIGIN): Promise<SoftAuthenticator> {
  const soft = await SoftAuthenticator.create({ rpID: RP_ID, origin });
  const options = await w.handle(post("/auth/passkey/register/options", {}, { cookie: w.cookie }));
  const { challenge, user } = (await options.json()) as {
    challenge: string;
    user: { id: string };
  };
  const res = await w.handle(
    post(
      "/auth/passkey/register/verify",
      { response: await soft.register(challenge, base64UrlBytes(user.id)) },
      { cookie: w.cookie },
    ),
  );
  expect(res.status).toBe(200);
  return soft;
}

/** A sign-in through the routes: the status and the error code of the verify. */
async function signIn(
  w: World,
  assertion: (challenge: string) => Promise<unknown>,
): Promise<{ status: number; error: string | undefined }> {
  const options = await w.handle(post("/auth/passkey/authenticate/options", {}));
  const { challenge } = (await options.json()) as { challenge: string };
  const res = await w.handle(
    post("/auth/passkey/authenticate/verify", { response: await assertion(challenge) }),
  );
  const body = (await res.json()) as { error?: string };
  return { status: res.status, error: body.error };
}

function base64UrlBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}

describe("the related origins document (WebAuthn Level 3)", () => {
  it("serves the related origins document on the RP ID host", async () => {
    const auth = authWith(RELATED);
    const res = await auth.wellKnown(new Request("https://example.com/.well-known/webauthn"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual({ origins: ["https://shop.example.net"] });
    // The route under basePath answers the same document when core is mounted on the RP ID host.
    const onRoot = authWith(RELATED, "https://example.com");
    const routed = await onRoot.handle(
      new Request("https://example.com/auth/.well-known/webauthn"),
    );
    expect(routed.status).toBe(200);
    expect(await routed.json()).toEqual({ origins: ["https://shop.example.net"] });
  });

  it("lists only the origins outside the RP ID's domain tree, in config order", async () => {
    // W3C WebAuthn Level 3 section 5.11.1: each listed origin can take one of
    // the five label slots. An origin on the tree would push out a fifth
    // outside label (ruling 8 of plan 12i, M1).
    const outside = [
      "https://shop.example.net",
      "https://b.example.org",
      "https://a.example.dev",
      "https://example.io",
      "https://c.example.co",
    ];
    const auth = authWith({
      ...RELATED,
      origins: [
        outside[0] ?? "",
        "https://example.com",
        APP_ORIGIN,
        outside[1] ?? "",
        "https://deep.app.example.com",
        ...outside.slice(2),
      ],
    });
    const res = await auth.wellKnown(new Request("https://example.com/.well-known/webauthn"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ origins: outside });
  });

  it("puts a host that only ends in the RP ID outside its domain tree", async () => {
    // evilexample.com ends in example.com, but it is no subdomain of it (ruling 10 of plan 12i).
    expect(onDomainTree("evilexample.com", RP_ID)).toBe(false);
    expect(onDomainTree("app.example.com", RP_ID)).toBe(true);
    expect(onDomainTree(RP_ID, RP_ID)).toBe(true);
    const auth = authWith({ ...RELATED, origins: [APP_ORIGIN, "https://evilexample.com"] });
    const res = await auth.wellKnown(new Request("https://example.com/.well-known/webauthn"));
    expect(await res.json()).toEqual({ origins: ["https://evilexample.com"] });
    // With relatedOrigins off, the config refuses the host as off the RP ID.
    expect(() =>
      authWith({
        rpID: RP_ID,
        rpName: "Example",
        origins: [APP_ORIGIN, "https://evilexample.com"],
      }),
    ).toThrow("passkey.origins host evilexample.com is not on rpID example.com");
  });

  it("answers 404 on another host and with relatedOrigins off", async () => {
    const auth = authWith(RELATED);
    for (const url of [
      "https://app.example.com/.well-known/webauthn",
      "https://shop.example.net/.well-known/webauthn",
    ]) {
      const res = await auth.wellKnown(new Request(url));
      expect({ url, status: res.status }).toEqual({ url, status: 404 });
    }
    const routed = await auth.handle(
      new Request("https://api.example.com/auth/.well-known/webauthn"),
    );
    expect(routed.status).toBe(404);
    expect(await routed.json()).toEqual({ error: "not_found" });
    const off = authWith({ rpID: RP_ID, rpName: "Example", origins: [APP_ORIGIN] });
    expect(
      (await off.wellKnown(new Request("https://example.com/.well-known/webauthn"))).status,
    ).toBe(404);
    const offRoot = authWith(
      { rpID: RP_ID, rpName: "Example", origins: ["https://example.com"] },
      "https://example.com",
    );
    const offRouted = await offRoot.handle(
      new Request("https://example.com/auth/.well-known/webauthn"),
    );
    expect(offRouted.status).toBe(404);
  });

  it("refuses six origins outside the RP ID's domain tree", () => {
    const outside = (n: number) =>
      Array.from({ length: n }, (_, i) => `https://shop${i}.example.net`);
    expect(() => authWith({ ...RELATED, origins: [APP_ORIGIN, ...outside(6)] })).toThrow(
      "relatedOrigins: at most five origins outside example.com, the minimum a client must support (WebAuthn Level 3)",
    );
    expect(() => authWith({ ...RELATED, origins: [APP_ORIGIN, ...outside(5)] })).not.toThrow();
    // Origins on the RP ID do not count.
    expect(() =>
      authWith({
        ...RELATED,
        origins: [APP_ORIGIN, "https://a.example.com", "https://b.example.com", ...outside(5)],
      }),
    ).not.toThrow();
    // With relatedOrigins off, one origin outside the RP ID is refused, as before.
    expect(() => authWith({ rpID: RP_ID, rpName: "Example", origins: [APP_ORIGIN, SHOP] })).toThrow(
      "passkey.origins host shop.example.net is not on rpID example.com",
    );
  });

  it("never passes a ceremony from an origin outside passkey.origins", async () => {
    const w = await passkeyWorld(RELATED);
    // A related origin of the list passes both ceremonies.
    const shop = await register(w, SHOP);
    expect(await signIn(w, (c) => shop.authenticate(c))).toEqual({
      status: 200,
      error: undefined,
    });
    // The same credential, used on an origin outside the list, fails.
    expect(await signIn(w, (c) => shop.authenticate(c, { origin: EVIL }))).toEqual({
      status: 400,
      error: "passkey_failed",
    });
    // A registration from an origin outside the list stores nothing.
    const evil = await SoftAuthenticator.create({ rpID: RP_ID, origin: EVIL });
    const options = await w.handle(
      post("/auth/passkey/register/options", {}, { cookie: w.cookie }),
    );
    const { challenge } = (await options.json()) as { challenge: string };
    const res = await w.handle(
      post(
        "/auth/passkey/register/verify",
        { response: await evil.register(challenge) },
        { cookie: w.cookie },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "passkey_failed" });
    expect(await w.auth.storage.findMany("passkey", [])).toHaveLength(1);
  });
});

describe("the form of the RP ID (ruling 10 of plan 12i)", () => {
  it("refuses an RP ID that is not lowercase ASCII and names the punycode form", () => {
    for (const [rpID, form] of [
      ["Example.com", "example.com"],
      ["bücher.example", "xn--bcher-kva.example"],
      ["BÜCHER.example", "xn--bcher-kva.example"],
    ] as const) {
      expect(() => authWith({ rpID, rpName: "Example", origins: [APP_ORIGIN] })).toThrow(
        `passkey.rpID ${rpID} is not lowercase ASCII; write the punycode form ${form}`,
      );
    }
    // A user part, a port, a path, a query, or a fragment: no host form fits,
    // and the message names no other host (final fix wave item 1).
    for (const rpID of [
      "ada@example.com",
      "Ada@Example.com",
      "example.com:8443",
      "example.com:443",
      "example.com/app",
      "example.com?x",
      "example.com#x",
    ])
      expect(() => authWith({ rpID, rpName: "Example", origins: [APP_ORIGIN] })).toThrow(
        `passkey.rpID ${rpID} is not a host; write the host alone, with no user part, port, or path`,
      );
    // The punycode form passes, with its origins.
    expect(() =>
      authWith({
        rpID: "xn--bcher-kva.example",
        rpName: "Example",
        origins: ["https://app.xn--bcher-kva.example"],
      }),
    ).not.toThrow();
  });
});

describe("the hints (WebAuthn Level 3)", () => {
  it("writes the hints into both options", async () => {
    const w = await passkeyWorld({
      ...RELATED,
      hints: { register: ["security-key"], signIn: ["hybrid"] },
    });
    const creation = (await (
      await w.handle(post("/auth/passkey/register/options", {}, { cookie: w.cookie }))
    ).json()) as { hints?: string[]; authenticatorSelection?: Record<string, unknown> };
    expect(creation.hints).toEqual(["security-key"]);
    // A hint is advice: it sets no attachment, which would filter the authenticators.
    expect(creation.authenticatorSelection).toEqual({
      residentKey: "required",
      userVerification: "required",
      requireResidentKey: true,
    });
    const request = (await (
      await w.handle(post("/auth/passkey/authenticate/options", {}))
    ).json()) as { hints?: string[] };
    expect(request.hints).toEqual(["hybrid"]);
    // With no hint in the config, the request options hold no hints key.
    const plain = await passkeyWorld(RELATED);
    const none = (await (
      await plain.handle(post("/auth/passkey/authenticate/options", {}))
    ).json()) as Record<string, unknown>;
    expect("hints" in none).toBe(false);
  });

  it("takes hints in the body for one ceremony and refuses another value", async () => {
    const w = await passkeyWorld({ ...RELATED, hints: { register: ["security-key"] } });
    const creation = await w.handle(
      post("/auth/passkey/register/options", { hints: ["client-device"] }, { cookie: w.cookie }),
    );
    expect(((await creation.json()) as { hints?: string[] }).hints).toEqual(["client-device"]);
    const request = await w.handle(
      post("/auth/passkey/authenticate/options", { hints: ["hybrid", "security-key"] }),
    );
    expect(((await request.json()) as { hints?: string[] }).hints).toEqual([
      "hybrid",
      "security-key",
    ]);
    for (const hints of [["phone"], ["hybrid", "hybrid"]]) {
      for (const [path, headers] of [
        ["/auth/passkey/register/options", { cookie: w.cookie }],
        ["/auth/passkey/authenticate/options", {}],
      ] as const) {
        const res = await w.handle(post(path, { hints }, headers));
        expect({ path, hints, status: res.status, body: await res.json() }).toEqual({
          path,
          hints,
          status: 400,
          body: { error: "invalid_body" },
        });
      }
    }
    // A request with no body keeps working: the body is optional.
    const bare = await w.handle(
      new Request("https://api.example.com/auth/passkey/authenticate/options", {
        method: "POST",
        headers: { origin: APP_ORIGIN },
      }),
    );
    expect(bare.status).toBe(200);
  });

  it("refuses a config hint list with a value twice or an unknown value", () => {
    expect(() =>
      authWith({ ...RELATED, hints: { register: ["hybrid", "security-key", "hybrid"] } }),
    ).toThrow("passkey.hints.register has a value twice");
    expect(() =>
      // @ts-expect-error: "phone" is no hint; a JavaScript config can hold it.
      authWith({ ...RELATED, hints: { signIn: ["security-key", "phone"] } }),
    ).toThrow(
      "passkey.hints.signIn has phone; a hint is one of security-key, client-device, hybrid",
    );
    expect(() =>
      authWith({ ...RELATED, hints: { register: ["client-device"], signIn: ["hybrid"] } }),
    ).not.toThrow();
  });
});

describe("the inputs of the Signal API (WebAuthn Level 3)", () => {
  it("answers passkey_unknown for a credential with no row and passkey_failed for a bad signature", async () => {
    const w = await passkeyWorld(RELATED);
    const soft = await register(w);
    const stranger = await SoftAuthenticator.create({ rpID: RP_ID, origin: APP_ORIGIN });
    const forged = async (challenge: string) => {
      const response = await stranger.authenticate(challenge);
      response.id = soft.credentialId;
      response.rawId = soft.credentialId;
      return response;
    };
    expect(await signIn(w, forged)).toEqual({ status: 400, error: "passkey_failed" });
    const list = (await (await w.handle(get("/auth/passkeys", { cookie: w.cookie }))).json()) as {
      passkeys: { id: string }[];
    };
    const id = list.passkeys[0]?.id;
    const deleted = await w.handle(post("/auth/passkeys/delete", { id }, { cookie: w.cookie }));
    expect(deleted.status).toBe(200);
    expect(await signIn(w, (c) => soft.authenticate(c))).toEqual({
      status: 400,
      error: "passkey_unknown",
    });
  });

  it("answers rpId and userHandle on the passkey list", async () => {
    const w = await passkeyWorld(RELATED);
    // A name of the person, so the display name differs from the user name.
    const session = await resolveSession(w.auth.config, w.cookie.split("=")[1] ?? "");
    if (!session) throw new Error("no session");
    expect((await updateProfile(w.auth.config, { session, name: "Ada Lovelace" })).ok).toBe(true);
    const options = await w.handle(
      post("/auth/passkey/register/options", {}, { cookie: w.cookie }),
    );
    const creation = (await options.json()) as {
      user: { id: string; name: string; displayName: string };
    };
    const res = await w.handle(get("/auth/passkeys", { cookie: w.cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      passkeys: unknown[];
      rpId: string;
      userHandle: string;
      userName: string;
      userDisplayName: string;
    };
    // The user handle is base64url of the user id bytes, as the registration options carry it.
    const expected = btoa(w.user.id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    // The names of signalCurrentUserDetails (plan 12i Task 15) are those of the options.
    expect(body).toEqual({
      passkeys: [],
      rpId: "example.com",
      userHandle: expected,
      userName: creation.user.name,
      userDisplayName: creation.user.displayName,
    });
    expect(body.userHandle).toBe(creation.user.id);
    expect([body.userName, body.userDisplayName]).toEqual(["ada@example.com", "Ada Lovelace"]);
  });
});

const PW = "correct horse battery";
const SF_RP = { rpID: RP_ID, rpName: "Example", origins: [APP_ORIGIN] };

/** The `name=value` part of the session Set-Cookie of `res`. */
function sessionPair(res: Response): string {
  const c = res.headers.getSetCookie().find((v) => v.startsWith("__Host-tempo_session="));
  if (!c) throw new Error(`the answer ${res.status} set no session cookie`);
  return c.split(";")[0] ?? "";
}

/**
 * A verified user with a password and one registered passkey, the session
 * cookie of a password sign-in, and a soft authenticator that has no row.
 */
async function factorWorld() {
  const h = pwHandle({ hash: FAST }, { passkey: SF_RP });
  const email = "ada@example.com";
  const up = await h.auth.handle(post("/auth/password/sign-up", { email, password: PW }));
  const token = h.mails.findLast((m) => m.to === email && m.subject.startsWith("Confirm"))?.token;
  if (!token) throw new Error("no confirm mail");
  // The sign-up's own browser keeps the password (ruling 11 of plan 12q).
  await h.auth.handle(post("/auth/password/verify", { token }, proofCookie(up)));
  const signedIn = await h.auth.handle(post("/auth/password/sign-in", { email, password: PW }));
  const user = await h.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error("no user");
  const soft = await SoftAuthenticator.create({ rpID: RP_ID, origin: APP_ORIGIN });
  const options = await passkeyRegistrationOptions(h.config, {
    session: await sessionFor(h.config, user),
  });
  if (!options.ok) throw new Error(options.code);
  const registered = await verifyPasskeyRegistration(h.config, {
    session: await sessionFor(h.config, user),
    response: await soft.register(options.value.challenge, new TextEncoder().encode(user.id)),
  });
  if (!registered.ok) throw new Error(registered.code);
  const stranger = await SoftAuthenticator.create({ rpID: RP_ID, origin: APP_ORIGIN });
  return { h, email, cookie: sessionPair(signedIn), soft, stranger };
}

/** A sign-in assertion of `soft` over new sign-in options: the enable's proof. */
async function signInAssertion(
  h: ReturnType<typeof pwHandle>,
  soft: SoftAuthenticator,
): Promise<unknown> {
  const options = await passkeyAuthenticationOptions(h.config, { ip: null });
  if (!options.ok) throw new Error(options.code);
  return soft.authenticate(options.value.challenge);
}

describe("a credential with no row at the other passkey routes (ruling 8 of plan 12i, M2)", () => {
  it("answers passkey_failed at the re-authentication proof", async () => {
    const { h, cookie, stranger } = await factorWorld();
    const options = await h.auth.handle(post("/auth/reauth/passkey/options", {}, { cookie }));
    expect(options.status).toBe(200);
    const { challenge } = (await options.json()) as { challenge: string };
    const res = await h.auth.handle(
      post("/auth/reauth", { passkey: await stranger.authenticate(challenge) }, { cookie }),
    );
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 400,
      body: { error: "passkey_failed" },
    });
  });

  it("answers passkey_failed at the enable of the passkey method", async () => {
    const { h, cookie, stranger } = await factorWorld();
    const res = await h.auth.handle(
      post(
        "/auth/second-factor/passkey/enable",
        { password: PW, response: await signInAssertion(h, stranger) },
        { cookie },
      ),
    );
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 400,
      body: { error: "passkey_failed" },
    });
    expect(await h.storage.findMany("secondFactor", [])).toEqual([]);
  });

  it("answers invalid_code at the challenge verify, and counts the attempt", async () => {
    const { h, email, cookie, soft, stranger } = await factorWorld();
    const enable = await h.auth.handle(
      post(
        "/auth/second-factor/passkey/enable",
        { password: PW, response: await signInAssertion(h, soft) },
        { cookie },
      ),
    );
    expect(enable.status).toBe(200);
    const signIn = await h.auth.handle(post("/auth/password/sign-in", { email, password: PW }));
    const { twoFactor } = (await signIn.json()) as { twoFactor: { challenge: string } };
    const optionsRes = await h.auth.handle(
      post("/auth/second-factor/passkey/options", { challenge: twoFactor.challenge }),
    );
    expect(optionsRes.status).toBe(200);
    const options = (await optionsRes.json()) as { challenge: string };
    const res = await h.auth.handle(
      post("/auth/totp/verify", {
        challenge: twoFactor.challenge,
        passkey: await stranger.authenticate(options.challenge),
      }),
    );
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 400,
      body: { error: "invalid_code" },
    });
    const rows = await h.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "two-factor" },
    ]);
    expect(rows.map((r) => (r.data as { attempts?: number } | null)?.attempts)).toEqual([1]);
  });
});
