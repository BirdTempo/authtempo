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
});
