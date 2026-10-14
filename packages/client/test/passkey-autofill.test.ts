import { SoftAuthenticator } from "@authtempo/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import {
  type BrowserWebAuthn,
  type CeremonyOptions,
  supportsAutofill,
  WebAuthnCancelled,
} from "../src/webauthn.js";
import { APP_ORIGIN, BASE_URL, inProcessFetch, makeServer, tokenFromMail } from "./harness.js";

const RP = { rpID: "example.com", rpName: "Example", origins: [APP_ORIGIN] };

/** The soft authenticator behind the seam. `wait` makes `get` hold until its signal aborts. */
function seamOf(soft: SoftAuthenticator, wait = false) {
  const seen: (CeremonyOptions | undefined)[] = [];
  const seam: BrowserWebAuthn = {
    create: (options) => soft.register(options.challenge),
    async get(options, ceremony) {
      seen.push(ceremony);
      if (wait)
        await new Promise<void>((_, reject) =>
          ceremony?.signal?.addEventListener("abort", () => reject(new WebAuthnCancelled())),
        );
      return soft.authenticate(options.challenge);
    },
  };
  return { seam, seen };
}

/** Conditional mediation as the browser reports it. */
function stubAutofill(available: boolean) {
  vi.stubGlobal("PublicKeyCredential", {
    isConditionalMediationAvailable: async () => available,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function withPasskey() {
  const server = makeServer({ passkey: RP });
  const soft = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
  const owner = createClient({
    baseURL: BASE_URL,
    fetch: inProcessFetch(server.auth).fetch,
    webauthn: seamOf(soft).seam,
  });
  await owner.magicLink.request({ email: "ada@example.com" });
  await owner.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
  const reg = await owner.passkey.register({ name: "laptop" });
  if (!reg.ok) throw new Error(reg.code);
  return { server, soft };
}

describe("passkey autofill (plan 11d)", () => {
  it("answers whether the browser has conditional mediation", async () => {
    expect(await supportsAutofill()).toBe(false);
    stubAutofill(true);
    expect(await supportsAutofill()).toBe(true);
  });

  it("signs in through the autofill with conditional mediation and a signal", async () => {
    const { server, soft } = await withPasskey();
    stubAutofill(true);
    const { seam, seen } = seamOf(soft);
    const browser = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: seam,
    });
    const r = await browser.passkey.signIn({ autofill: true });
    expect(r.ok && r.value.user.email).toBe("ada@example.com");
    expect(seen[0]?.mediation).toBe("conditional");
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers cancelled with no request where autofill is not available (Review Focus 5)", async () => {
    const { server, soft } = await withPasskey();
    stubAutofill(false);
    let requests = 0;
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      return inProcessFetch(server.auth).fetch(input, init);
    }) as typeof fetch;
    const browser = createClient({
      baseURL: BASE_URL,
      fetch: counting,
      webauthn: seamOf(soft).seam,
    });
    expect(await browser.passkey.signIn({ autofill: true })).toEqual({
      ok: false,
      code: "cancelled",
      status: 0,
    });
    expect(requests).toBe(0);
  });

  it("ends a waiting autofill on abort, which answers cancelled", async () => {
    const { server, soft } = await withPasskey();
    stubAutofill(true);
    const browser = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: seamOf(soft, true).seam,
    });
    const waiting = browser.passkey.signIn({ autofill: true });
    await new Promise((r) => setTimeout(r, 10));
    browser.passkey.abort();
    expect(await waiting).toEqual({ ok: false, code: "cancelled", status: 0 });
  });

  it("keeps the modal sign-in with no mediation", async () => {
    const { server, soft } = await withPasskey();
    const { seam, seen } = seamOf(soft);
    const browser = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: seam,
    });
    const r = await browser.passkey.signIn();
    expect(r.ok).toBe(true);
    expect(seen[0]?.mediation).toBeUndefined();
  });
});

describe("passkey autofill fix round (plan 11d Task 6 review)", () => {
  it("answers cancelled with no ceremony when abort() comes before the options answer (J1)", async () => {
    const { server, soft } = await withPasskey();
    stubAutofill(true);
    const { seam, seen } = seamOf(soft);
    const browser = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: seam,
    });
    const waiting = browser.passkey.signIn({ autofill: true });
    browser.passkey.abort();
    expect(await waiting).toEqual({ ok: false, code: "cancelled", status: 0 });
    expect(seen).toHaveLength(0);
  });

  it("ends a waiting autofill when a modal sign-in starts, and the modal one signs in (J2)", async () => {
    const { server, soft } = await withPasskey();
    stubAutofill(true);
    // The conditional get waits for its signal; a modal get answers at once.
    const seam: BrowserWebAuthn = {
      create: (options) => soft.register(options.challenge),
      async get(options, ceremony) {
        if (ceremony?.mediation === "conditional")
          await new Promise<void>((_, reject) =>
            ceremony.signal?.addEventListener("abort", () => reject(new WebAuthnCancelled())),
          );
        return soft.authenticate(options.challenge);
      },
    };
    const browser = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: seam,
    });
    const autofill = browser.passkey.signIn({ autofill: true });
    await new Promise((r) => setTimeout(r, 10));
    const modal = await browser.passkey.signIn();
    expect(modal.ok && modal.value.user.email).toBe("ada@example.com");
    expect(await autofill).toEqual({ ok: false, code: "cancelled", status: 0 });
  });
});

describe("passkey register and a waiting autofill (plan 11d Task 6 re-review, N3)", () => {
  it("ends a waiting autofill when a passkey register starts", async () => {
    const { server, soft } = await withPasskey();
    stubAutofill(true);
    // A second authenticator: the first one already holds a passkey of this user.
    const phone = await SoftAuthenticator.create({ rpID: RP.rpID, origin: APP_ORIGIN });
    const seam: BrowserWebAuthn = {
      create: (options) => phone.register(options.challenge),
      async get(options, ceremony) {
        if (ceremony?.mediation === "conditional")
          await new Promise<void>((_, reject) =>
            ceremony.signal?.addEventListener("abort", () => reject(new WebAuthnCancelled())),
          );
        return soft.authenticate(options.challenge);
      },
    };
    const browser = createClient({
      baseURL: BASE_URL,
      fetch: inProcessFetch(server.auth).fetch,
      webauthn: seam,
    });
    await browser.magicLink.request({ email: "ada@example.com" });
    await browser.magicLink.verify({ token: tokenFromMail(server.mail.at(-1)?.text ?? "") });
    const autofill = browser.passkey.signIn({ autofill: true });
    await new Promise((r) => setTimeout(r, 10));
    const reg = await browser.passkey.register({ name: "phone" });
    expect(reg.ok ? "ok" : `${reg.code} ${reg.status}`).toBe("ok");
    expect(await autofill).toEqual({ ok: false, code: "cancelled", status: 0 });
  });
});
