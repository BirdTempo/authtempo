import { SoftAuthenticator } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import type { BrowserWebAuthn } from "../src/webauthn.js";
import { WebAuthnCancelled } from "../src/webauthn.js";
import { APP_ORIGIN, BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const RP = { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] };

/** A seam over the soft authenticator, so the ceremonies run with no browser. */
function softSeam(soft: SoftAuthenticator): BrowserWebAuthn & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async create(options) {
      calls.push("create");
      // The engine never reads the user handle; the challenge is what it checks.
      return soft.register(options.challenge);
    },
    async get(options) {
      calls.push("get");
      return soft.authenticate(options.challenge);
    },
  };
}

function passkeyServer() {
  return makeServer({ passkey: RP });
}

async function cookieClient(server: ReturnType<typeof passkeyServer>, webauthn: BrowserWebAuthn) {
  const { fetch, jar } = inProcessFetch(server.auth);
  const client = createClient({ baseURL: BASE_URL, fetch, webauthn });
  const req = await client.magicLink.request({ email: "ada@example.com" });
  if (!req.ok) throw new Error(req.code);
  const v = await client.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
  if (!v.ok) throw new Error(v.code);
  return { client, jar };
}

describe("passkeys through the client", () => {
  it("registers, lists, signs in with a fresh client, and deletes", async () => {
    const server = passkeyServer();
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
    const seam = softSeam(soft);
    const { client } = await cookieClient(server, seam);
    const reg = await client.passkey.register({ name: "laptop" });
    expect(reg.ok && reg.value.name).toBe("laptop");
    expect(seam.calls).toEqual(["create"]);
    const list = await client.passkeys.list();
    expect(list.ok && list.value.map((p) => p.name)).toEqual(["laptop"]);
    expect(list.ok && typeof list.value[0]?.createdAt).toBe("string");

    const fresh = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: seam,
    });
    expect(await fresh.session()).toEqual({ ok: true, value: null });
    const s = await fresh.passkey.signIn();
    expect(s.ok && s.value.user.email).toBe("ada@example.com");
    const after = await fresh.session();
    expect(after.ok && after.value?.user.email).toBe("ada@example.com");

    const id = list.ok ? (list.value[0]?.id ?? "") : "";
    expect(await client.passkeys.delete({ id })).toEqual({ ok: true, value: { ok: true } });
    const empty = await client.passkeys.list();
    expect(empty.ok && empty.value).toEqual([]);
  });

  it("renames a passkey, and refuses a name of another rule or the id of another user's passkey (plan 12a)", async () => {
    const server = passkeyServer();
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
    const { client } = await cookieClient(server, softSeam(soft));
    const reg = await client.passkey.register({ name: "laptop" });
    if (!reg.ok) throw new Error(reg.code);
    const renamed = await client.passkeys.rename({ id: reg.value.id, name: "Work laptop" });
    expect(renamed).toEqual({ ok: true, value: { ...reg.value, name: "Work laptop" } });
    const list = await client.passkeys.list();
    expect(list.ok && list.value.map((p) => p.name)).toEqual(["Work laptop"]);
    expect(await client.passkeys.rename({ id: reg.value.id, name: "a\u202eb" })).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
    });
    // Another user's passkey answers as an unknown id.
    const bob = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: softSeam(soft),
    });
    const req = await bob.magicLink.request({ email: "bob@example.com" });
    if (!req.ok) throw new Error(req.code);
    const v = await bob.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
    if (!v.ok) throw new Error(v.code);
    expect(await bob.passkeys.rename({ id: reg.value.id, name: "Mine" })).toEqual({
      ok: false,
      code: "not_found",
      status: 404,
    });
    const after = await client.passkeys.list();
    expect(after.ok && after.value.map((p) => p.name)).toEqual(["Work laptop"]);
  });

  it("reaches the register and management routes with a bearer token and no cookie (plan 4 input)", async () => {
    const server = passkeyServer();
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
    await cookieClient(server, softSeam(soft));
    const req = await server.auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
    if (!req.ok) throw new Error(req.code);
    const v = await server.auth.api.verifyMagicLink({
      token: tokenFromMail(server.mail.at(-1)?.text ?? ""),
      ip: null,
      userAgent: null,
    });
    if (!v.ok) throw new Error(v.code);
    if (!("token" in v.value)) throw new Error("the sign-in answered a challenge");
    const bearer = v.value.token;
    const native = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      credentials: "omit",
      token: () => bearer,
      webauthn: softSeam(soft),
    });
    const reg = await native.passkey.register({ name: "phone" });
    expect(reg.ok && reg.value.name).toBe("phone");
    const list = await native.passkeys.list();
    expect(list.ok && list.value).toHaveLength(1);
  });

  it("answers unauthorized for register without a session, and passes email_unverified through", async () => {
    const server = passkeyServer();
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
    const seam = softSeam(soft);
    const anon = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: seam,
    });
    expect(await anon.passkey.register()).toEqual({ ok: false, code: "unauthorized", status: 401 });
    expect(seam.calls).toEqual([]);
    // An unverified user: seed through the api, then mark unverified in storage.
    const { client } = await cookieClient(server, seam);
    const user = await server.storage.findOne("user", [
      { field: "email", op: "eq", value: "ada@example.com" },
    ]);
    if (!user) throw new Error("no user");
    await server.storage.update("user", [{ field: "id", op: "eq", value: user.id }], {
      emailVerified: false,
    });
    expect(await client.passkey.register()).toEqual({
      ok: false,
      code: "email_unverified",
      status: 403,
    });
  });

  it("answers cancelled when the prompt is dismissed and sends no verify (Review Focus 2)", async () => {
    const server = passkeyServer();
    const calls: string[] = [];
    const { fetch } = inProcessFetch(server.auth);
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init).url);
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    const client = createClient({
      baseURL: BASE_URL,
      fetch: counting,
      webauthn: {
        async create() {
          throw new WebAuthnCancelled();
        },
        async get() {
          throw new WebAuthnCancelled();
        },
      },
    });
    expect(await client.passkey.signIn()).toEqual({ ok: false, code: "cancelled", status: 0 });
    expect(calls).toEqual([`${BASE_URL}/auth/passkey/authenticate/options`]);
  });

  it("answers unexpected when the seam throws something else", async () => {
    const server = passkeyServer();
    const client = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: {
        async create() {
          throw new Error("boom");
        },
        async get() {
          throw new Error("boom");
        },
      },
    });
    expect(await client.passkey.signIn()).toEqual({ ok: false, code: "unexpected", status: 0 });
  });

  it("sends PRF salts and a largeBlob read, and keeps both outputs in the browser (plan 12i)", async () => {
    const server = makeServer({
      passkey: { ...RP, extensions: { prf: true, largeBlob: "preferred", credProps: true } },
    });
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
    const seam = softSeam(soft);
    const { client } = await cookieClient(server, seam);
    const reg = await client.passkey.register();
    if (!reg.ok) throw new Error(reg.code);
    const first = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const asked: unknown[] = [];
    const prfOutput = "cHJmLW91dHB1dC1zZWNyZXQ";
    const blob = "bGFyZ2UtYmxvYi1zZWNyZXQ";
    const outputs: BrowserWebAuthn = {
      create: seam.create,
      async get(options) {
        asked.push(options.extensions);
        return {
          ...(await soft.authenticate(options.challenge)),
          clientExtensionResults: {
            prf: { enabled: true, results: { first: prfOutput } },
            largeBlob: { blob },
          } as never,
        };
      },
    };
    const bodies: string[] = [];
    const { fetch } = inProcessFetch(server.auth);
    const spy: typeof globalThis.fetch = async (input, init) => {
      bodies.push(await new Request(input, init).clone().text());
      return fetch(input, init);
    };
    const fresh = createClient({ baseURL: BASE_URL, fetch: spy, webauthn: outputs });
    const got: unknown[] = [];
    const s = await fresh.passkey.signIn({
      extensions: { prf: { first }, largeBlob: { read: true } },
      onExtensionResults: (r) => got.push(r),
    });
    expect(s.ok).toBe(true);
    expect(asked).toEqual([{ prf: { eval: { first } }, largeBlob: { read: true } }]);
    expect(got).toEqual([{ prf: { first: prfOutput }, largeBlob: blob }]);
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[0] ?? "")).toEqual({
      extensions: { prf: { first }, largeBlob: { read: true } },
    });
    // The verify body holds neither output.
    expect(bodies[1]).not.toContain(prfOutput);
    expect(bodies[1]).not.toContain(blob);
    // A sign-in that fails gives the app no output.
    await client.passkeys.delete({ id: reg.value.id });
    const failed = await fresh.passkey.signIn({
      extensions: { prf: { first } },
      onExtensionResults: (r) => got.push(r),
    });
    expect(failed.ok).toBe(false);
    expect(got).toHaveLength(1);
  });

  it("keeps the outputs of a registration in the browser (plan 12i)", async () => {
    const server = makeServer({ passkey: { ...RP, extensions: { prf: true, credProps: true } } });
    const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: RP.origins[0] ?? "" });
    const prfOutput = "cmVnaXN0ZXItcHJmLXNlY3JldA";
    const webauthn: BrowserWebAuthn = {
      async create(options) {
        return {
          ...(await soft.register(options.challenge)),
          clientExtensionResults: {
            credProps: { rk: true },
            prf: { enabled: true, results: { first: prfOutput } },
          } as never,
        };
      },
      get: async (options) => soft.authenticate(options.challenge),
    };
    const bodies: string[] = [];
    const { fetch } = inProcessFetch(server.auth);
    const spy: typeof globalThis.fetch = async (input, init) => {
      bodies.push(await new Request(input, init).clone().text());
      return fetch(input, init);
    };
    const client = createClient({ baseURL: BASE_URL, fetch: spy, webauthn });
    const req = await client.magicLink.request({ email: "ada@example.com" });
    if (!req.ok) throw new Error(req.code);
    const token = tokenFromMail(server.mail.at(-1)?.text ?? "");
    const v = await client.magicLink.verify({ token });
    if (!v.ok) throw new Error(v.code);
    const reg = await client.passkey.register();
    expect(reg.ok && { discoverable: reg.value.discoverable, prf: reg.value.prf }).toEqual({
      discoverable: true,
      prf: true,
    });
    const verifyBody = bodies.at(-1) ?? "";
    expect(verifyBody).toContain('"enabled":true');
    expect(verifyBody).not.toContain(prfOutput);
  });
});
