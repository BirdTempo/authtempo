import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { resolveConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { CIMD_REVISION, DEVICE_GRANT, findClient } from "../src/engine/oauth-clients.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { randomBase64Url, toBase64Url } from "../src/primitives/crypto.js";
import { APP_ORIGIN, BASE_URL, makeAuth, post } from "./helpers.js";
import {
  authorized,
  type Handle,
  ISSUER,
  oauthHandle,
  pkce,
  RESOURCE,
  SCOPES,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";

/**
 * The node:fs read of the fixtures and of the source. Core's typecheck has
 * no Node types, because core runs on Workers; vitest runs in Node. A
 * specifier in a constant keeps the import out of the typecheck.
 */
interface SourceFs {
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";
const readText = async (path: string) => {
  const { readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
  return readFileSync(new URL(path, import.meta.url), "utf8");
};
const fixture = async (name: string) =>
  JSON.parse(await readText(`./fixtures/cimd/${name}.json`)) as Record<string, unknown>;

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const REFUSED_LOG = "authtempo: client metadata document refused";
const enc = new TextEncoder();

interface Key {
  kid: string;
  jwk: Record<string, unknown>;
  privateKey: CryptoKey;
}

/** An Ed25519 key that this test generates, with its public JWK. */
async function keyOf(kid: string): Promise<Key> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  return { kid, jwk: { ...jwk, kid }, privateKey: pair.privateKey };
}

/** A good client assertion of `clientId` (RFC 7523 section 3), signed by `key`. */
async function assertion(h: Handle, key: Key, clientId: string): Promise<string> {
  const now = Math.floor(h.clock.now().getTime() / 1000);
  const header = { alg: "EdDSA", kid: key.kid, typ: "client-authentication+jwt" };
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: ISSUER,
    exp: now + 60,
    iat: now,
    jti: randomBase64Url(16),
  };
  const input = `${toBase64Url(enc.encode(JSON.stringify(header)))}.${toBase64Url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, enc.encode(input));
  return `${input}.${toBase64Url(new Uint8Array(sig))}`;
}

const json = (body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A fake `oauth.fetch` that answers from a map and counts its calls. */
function fakeFetch() {
  const answers = new Map<string, () => Response>();
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const answer = answers.get(url);
    if (!answer) throw new Error(`no fake answer for ${url}`);
    return answer();
  }) as typeof fetch;
  return { fn, answers, calls };
}

/** One instance with CIMD on over `base`: each call has its own document cache. */
function instance(
  fetchFn: typeof fetch,
  base = makeAuth(),
  device?: Record<string, never>,
): Handle {
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage: base.storage,
    mail: { send: async () => {} },
    clock: base.clock,
    limiter: createMemoryLimiter(base.clock),
    oauth: { resources: [RESOURCE], scopes: SCOPES, fetch: fetchFn, ...(device ? { device } : {}) },
  };
  return {
    auth: createAuth(input),
    config: resolveConfig(input),
    storage: base.storage,
    clock: base.clock,
  };
}

async function answer(res: Response) {
  return { status: res.status, body: res.status === 200 ? null : await res.json() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the CIMD revision -02 (plan 12e Task 6)", () => {
  it("accepts the -00 fixture as a public client", async () => {
    const doc = await fixture("draft-00");
    const url = String(doc.client_id);
    const f = fakeFetch();
    f.answers.set(url, () => json(doc));
    const h = instance(f.fn);
    expect(await findClient(h.config, url)).toMatchObject({
      id: url,
      kind: "cimd",
      name: "Example MCP Client",
      redirectUris: ["http://127.0.0.1:3000/callback", "http://localhost:3000/callback"],
      authMethod: "none",
      secretHash: null,
      jwks: null,
      jwksUri: null,
      grantTypes: ["authorization_code"],
    });
    const s = await signedIn(h);
    const p = await pkce();
    const redirect = "http://127.0.0.1:3000/callback";
    const { code } = await authorized(h, s.cookie, {
      clientId: url,
      challenge: p.challenge,
      redirectUri: redirect,
    });
    const res = await h.auth.handle(
      tokenPost({
        grant_type: "authorization_code",
        code,
        code_verifier: p.verifier,
        client_id: url,
        redirect_uri: redirect,
        resource: RESOURCE,
      }),
    );
    expect(await answer(res)).toEqual({ status: 200, body: null });
  });

  it("accepts the -02 fixture with private_key_jwt and jwks as a confidential client, and then needs an assertion", async () => {
    const fixed = await fixture("draft-02");
    const url = String(fixed.client_id);
    const jwksUrl = String(fixed.jwks_uri);
    const key = await keyOf("k-1");
    const { jwks_uri: _uri, ...inline } = fixed;
    // The fixture as it is (jwks_uri), and the same document with its set inline.
    for (const [form, doc] of [
      ["jwks_uri", fixed],
      ["jwks", { ...inline, jwks: { keys: [key.jwk] } }],
    ] as const) {
      const f = fakeFetch();
      f.answers.set(url, () => json(doc));
      f.answers.set(jwksUrl, () => json({ keys: [key.jwk] }));
      const h = instance(f.fn);
      expect({ form, row: await findClient(h.config, url) }).toMatchObject({
        form,
        row: {
          kind: "cimd",
          authMethod: "private_key_jwt",
          secretHash: null,
          ...(form === "jwks_uri"
            ? { jwks: null, jwksUri: jwksUrl }
            : { jwks: { keys: [key.jwk] }, jwksUri: null }),
        },
      });
      const s = await signedIn(h);
      const p = await pkce();
      const { code } = await authorized(h, s.cookie, { clientId: url, challenge: p.challenge });
      const body = {
        grant_type: "authorization_code",
        code,
        code_verifier: p.verifier,
        redirect_uri: String((fixed.redirect_uris as string[])[0]),
        resource: RESOURCE,
      };
      // A client_id alone is no auth for a confidential client. No Authorization header: 400 (ruling 19).
      const bare = await h.auth.handle(tokenPost({ ...body, client_id: url }));
      expect({ form, answer: await answer(bare) }).toEqual({
        form,
        answer: { status: 400, body: { error: "invalid_client" } },
      });
      // The refused auth spent nothing: the same code passes with an assertion.
      const res = await h.auth.handle(
        tokenPost({
          ...body,
          client_assertion_type: ASSERTION_TYPE,
          client_assertion: await assertion(h, key, url),
        }),
      );
      expect({ form, answer: await answer(res) }).toEqual({
        form,
        answer: { status: 200, body: null },
      });
      expect({ form, jwksReads: f.calls.filter((c) => c === jwksUrl).length }).toEqual({
        form,
        jwksReads: form === "jwks_uri" ? 1 : 0,
      });
    }
  });

  it("refuses a document with client_secret, client_secret_expires_at, or a shared-secret method (-02 section 4.1)", async () => {
    const base = await fixture("draft-00");
    const url = String(base.client_id);
    const cases: [Record<string, unknown>, string][] = [
      [{ client_secret: "doc-secret-0123456789" }, "client_secret is present (-02 section 4.1)"],
      [{ client_secret_expires_at: 0 }, "client_secret_expires_at is present (-02 section 4.1)"],
    ];
    for (const method of ["client_secret_basic", "client_secret_post", "client_secret_jwt"])
      cases.push([
        { token_endpoint_auth_method: method },
        "token_endpoint_auth_method is not none or private_key_jwt (-02 section 4.1)",
      ]);
    for (const [over, why] of cases) {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const f = fakeFetch();
      const marker = "Doc name 7f3a";
      f.answers.set(url, () => json({ ...base, ...over, client_name: marker }));
      const h = instance(f.fn);
      expect({ over, client: await findClient(h.config, url) }).toEqual({ over, client: null });
      expect(await h.storage.findMany("oauthClient", [])).toEqual([]);
      expect({ over, lines: log.mock.calls }).toEqual({ over, lines: [[REFUSED_LOG, why]] });
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain(marker);
      expect(logged).not.toContain("doc-secret-0123456789");
      log.mockRestore();
    }
  });

  it("refuses private key material and a jwks_uri on an internal host (-02 sections 4.1 and 8.6)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixed = await fixture("draft-02");
    const url = String(fixed.client_id);
    const key = await keyOf("k-1");
    const { jwks_uri: _uri, ...inline } = fixed;
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    for (const doc of [
      { ...inline, jwks: { keys: [{ ...privateJwk, kid: "k-p" }] } },
      { ...inline, jwks: { keys: [key.jwk, { ...privateJwk, kid: "k-p" }] } },
      { ...fixed, jwks_uri: "https://127.0.0.1/jwks.json" },
      { ...fixed, jwks_uri: "https://localhost/jwks.json" },
      { ...fixed, jwks_uri: "https://svc.internal/jwks.json" },
    ]) {
      const f = fakeFetch();
      f.answers.set(url, () => json(doc));
      const h = instance(f.fn);
      expect({ doc, client: await findClient(h.config, url) }).toEqual({ doc, client: null });
      // Only the document is fetched: no URL inside a refused document is read.
      expect(f.calls).toEqual([url]);
    }
  });

  it("refuses a document over 8 KB and accepts one of 8 KB", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = await fixture("draft-00");
    const url = String(base.client_id);
    const sized = (bytes: number) => {
      const empty = JSON.stringify({ ...base, x_pad: "" });
      return JSON.stringify({ ...base, x_pad: "x".repeat(bytes - empty.length) });
    };
    expect(enc.encode(sized(8192)).byteLength).toBe(8192);
    expect(enc.encode(sized(8193)).byteLength).toBe(8193);
    for (const [bytes, ok] of [
      [8192, true],
      [8193, false],
    ] as const) {
      const f = fakeFetch();
      f.answers.set(url, () => json(sized(bytes)));
      const h = instance(f.fn);
      const row = await findClient(h.config, url);
      expect({ bytes, found: row !== null }).toEqual({ bytes, found: ok });
    }
  });

  it("never caches a failed fetch", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = await fixture("draft-00");
    const url = String(base.client_id);
    // -02 section 5.2: no error answer and no invalid document is kept.
    for (const refused of [
      () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
      () => json({ ...base, client_secret: "doc-secret-0123456789" }),
    ]) {
      const f = fakeFetch();
      f.answers.set(url, refused);
      const h = instance(f.fn);
      expect(await findClient(h.config, url)).toBeNull();
      expect(await findClient(h.config, url)).toBeNull();
      expect(f.calls).toEqual([url, url]);
      expect(h.config.oauth?.cimdCache.size).toBe(0);
    }
  });

  it("refuses a code with no challenge when the client is not confidential at the exchange", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixed = await fixture("draft-02");
    const url = String(fixed.client_id);
    const key = await keyOf("k-1");
    const { jwks_uri: _uri, ...inline } = fixed;
    const keyDoc = { ...inline, jwks: { keys: [key.jwk] } };
    const { jwks: _jwks, ...rest } = keyDoc;
    const publicDoc = { ...rest, token_endpoint_auth_method: "none" };
    const base = makeAuth();
    // Instance A reads the private_key_jwt document. Instance B reads it later, after the client made it public.
    const fa = fakeFetch();
    fa.answers.set(url, () => json(keyDoc));
    const a = instance(fa.fn, base);
    const fb = fakeFetch();
    fb.answers.set(url, () => json(publicDoc));
    const b = instance(fb.fn, base);
    const s = await signedIn(a);
    // A confidential client may omit PKCE with openid and a nonce (RFC 9700 section 2.1.1).
    const codeOf = async () =>
      (
        await authorized(a, s.cookie, {
          clientId: url,
          challenge: null,
          scope: "openid",
          nonce: "n-1",
        })
      ).code;
    const body = (code: string) => ({
      grant_type: "authorization_code",
      code,
      redirect_uri: String((fixed.redirect_uris as string[])[0]),
      resource: RESOURCE,
    });
    // The confidential client passes with an assertion and no verifier.
    const first = await codeOf();
    const res = await a.auth.handle(
      tokenPost({
        ...body(first),
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: await assertion(a, key, url),
      }),
    );
    expect(await answer(res)).toEqual({ status: 200, body: null });
    // The code of the confidential client reaches instance B, which reads the public document.
    const second = await codeOf();
    const late = await b.auth.handle(tokenPost({ ...body(second), client_id: url }));
    expect(await answer(late)).toEqual({ status: 400, body: { error: "invalid_grant" } });
    expect(
      await b.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: url }]),
    ).toMatchObject({ authMethod: "none" });
  });

  it("names the revision", async () => {
    expect(CIMD_REVISION).toBe("draft-ietf-oauth-client-id-metadata-document-02");
    const source = (await readText("../src/engine/oauth-clients.ts")).replace(/\n \* /g, " ");
    expect(source).toContain(
      "Core implements draft-ietf-oauth-client-id-metadata-document-02 (6 July 2026) and accepts the documents of -00, which MCP 2026-07-28 pins.",
    );
  });
});

describe("the members of a document that core does not serve (ruling 24 of plan 12e)", () => {
  const DROPPED_LOG = "authtempo: client metadata member dropped";

  it("reads the live VS Code document as a public client and drops the device grant", async () => {
    const doc = await fixture("vscode");
    const url = String(doc.client_id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fakeFetch();
    f.answers.set(url, () => json(doc));
    const h = instance(f.fn);
    expect(await findClient(h.config, url)).toMatchObject({
      id: url,
      kind: "cimd",
      name: "Visual Studio Code",
      authMethod: "none",
      redirectUris: ["http://127.0.0.1:33418/", "https://vscode.dev/redirect"],
      grantTypes: ["authorization_code", "refresh_token"],
    });
    expect(warn.mock.calls).toEqual([[DROPPED_LOG, "grant_types"]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("device_code");
    const s = await signedIn(h);
    const p = await pkce();
    const redirect = "http://127.0.0.1:33418/";
    const { code } = await authorized(h, s.cookie, {
      clientId: url,
      challenge: p.challenge,
      redirectUri: redirect,
    });
    const res = await h.auth.handle(
      tokenPost({
        grant_type: "authorization_code",
        code,
        code_verifier: p.verifier,
        client_id: url,
        redirect_uri: redirect,
        resource: RESOURCE,
      }),
    );
    expect(await answer(res)).toEqual({ status: 200, body: null });
  });

  it("drops each member that core does not serve, and logs its name, never its value", async () => {
    const base = await fixture("draft-00");
    const url = String(base.client_id);
    const marker = "7f3a";
    const cases: [Record<string, unknown>, string, Record<string, unknown>][] = [
      [
        { grant_types: ["authorization_code", "client_credentials", `urn:x:${marker}`] },
        "grant_types",
        { grantTypes: ["authorization_code"] },
      ],
      [{ response_types: ["code", `id_token${marker}`] }, "response_types", {}],
      // Task 16 serves a logout URI on the document's own host; another host is dropped.
      [
        { backchannel_logout_uri: `https://other.example.com/bc-${marker}` },
        "backchannel_logout_uri",
        { backchannelLogoutUri: null },
      ],
      [
        { backchannel_logout_session_required: `yes-${marker}` },
        "backchannel_logout_session_required",
        { backchannelLogoutSessionRequired: false },
      ],
      [{ id_token_signed_response_alg: `RS256${marker}` }, "id_token_signed_response_alg", {}],
      [{ id_token_signed_response_alg: "RS256" }, "id_token_signed_response_alg", {}],
    ];
    for (const [over, member, row] of cases) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = fakeFetch();
      f.answers.set(url, () => json({ ...base, ...over }));
      const h = instance(f.fn);
      expect({ over, row: await findClient(h.config, url) }).toMatchObject({
        over,
        row: { id: url, authMethod: "none", ...row },
      });
      expect({ over, lines: warn.mock.calls }).toEqual({ over, lines: [[DROPPED_LOG, member]] });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
      warn.mockRestore();
    }
  });

  it("reads a null token_endpoint_auth_method as none, the same as a registration", async () => {
    const base = await fixture("draft-00");
    const url = String(base.client_id);
    const f = fakeFetch();
    f.answers.set(url, () => json({ ...base, token_endpoint_auth_method: null }));
    const h = instance(f.fn);
    expect(await findClient(h.config, url)).toMatchObject({ id: url, authMethod: "none" });
  });

  it("reads a null grant_types as an absent one, in a document and at registration", async () => {
    const base = await fixture("draft-00");
    const url = String(base.client_id);
    const f = fakeFetch();
    f.answers.set(url, () => json({ ...base, grant_types: null }));
    const h = instance(f.fn);
    expect(await findClient(h.config, url)).toMatchObject({
      grantTypes: ["authorization_code", "refresh_token"],
    });
    const r = oauthHandle();
    const res = await r.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: ["https://client.example.com/callback"],
        grant_types: null,
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  it("refuses a document with no code grant or no code response type", async () => {
    const base = await fixture("draft-00");
    const url = String(base.client_id);
    for (const [over, why] of [
      [{ grant_types: ["refresh_token"] }, "grant_types"],
      [{ grant_types: [] }, "grant_types"],
      [{ grant_types: "authorization_code" }, "grant_types"],
      [{ response_types: ["id_token"] }, "response_types"],
      [{ response_types: "code" }, "response_types"],
    ] as const) {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const f = fakeFetch();
      f.answers.set(url, () => json({ ...base, ...over }));
      const h = instance(f.fn);
      expect({ over, client: await findClient(h.config, url) }).toEqual({ over, client: null });
      expect({ over, lines: log.mock.calls }).toEqual({ over, lines: [[REFUSED_LOG, why]] });
      log.mockRestore();
    }
  });

  it("names the member of each refusal in the log, never its value", async () => {
    const base = await fixture("draft-00");
    const url = String(base.client_id);
    const marker = "7f3a";
    const key = await keyOf("k-1");
    const cases: [Record<string, unknown>, string][] = [
      [{ client_name: `${marker}${"n".repeat(80)}` }, "client_name"],
      [{ redirect_uris: [`http://client.example.com/${marker}`] }, "redirect_uris"],
      [{ post_logout_redirect_uris: [`javascript:${marker}`] }, "post_logout_redirect_uris"],
      [{ subject_type: `pairwise${marker}` }, "subject_type"],
      [{ dpop_bound_access_tokens: marker }, "dpop_bound_access_tokens"],
      [{ jwks: { keys: [{ kty: marker }] } }, "jwks"],
      [
        { jwks: { keys: [key.jwk] }, jwks_uri: `https://client.example.com/${marker}.json` },
        "jwks_uri",
      ],
      [{ jwks_uri: `https://127.0.0.1/${marker}.json` }, "jwks_uri"],
      [{ token_endpoint_auth_method: "private_key_jwt" }, "jwks"],
    ];
    for (const [over, why] of cases) {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const f = fakeFetch();
      f.answers.set(url, () => json({ ...base, ...over }));
      const h = instance(f.fn);
      expect({ over, client: await findClient(h.config, url) }).toEqual({ over, client: null });
      expect({ over, lines: log.mock.calls }).toEqual({ over, lines: [[REFUSED_LOG, why]] });
      expect(JSON.stringify(log.mock.calls)).not.toContain(marker);
      log.mockRestore();
    }
  });
});

describe("a document that changes its method (ruling 25 of plan 12e)", () => {
  const DROP_LOG =
    "authtempo: client metadata document dropped its client auth; refresh tokens and device codes revoked";

  /** The -02 fixture with its key inline, and the same document as a public client. */
  async function docs() {
    const fixed = await fixture("draft-02");
    const url = String(fixed.client_id);
    const key = await keyOf("k-1");
    const { jwks_uri: _uri, ...inline } = fixed;
    const keyDoc = { ...inline, jwks: { keys: [key.jwk] } };
    const publicDoc = { ...inline, token_endpoint_auth_method: "none" };
    return { url, key, keyDoc, publicDoc };
  }

  /** Instance A reads `first`; instance B, on the same storage, reads `then`. */
  function pair(url: string, first: unknown, then: unknown) {
    const base = makeAuth();
    const fa = fakeFetch();
    fa.answers.set(url, () => json(first));
    const fb = fakeFetch();
    fb.answers.set(url, () => json(then));
    return { a: instance(fa.fn, base), b: instance(fb.fn, base), fb };
  }

  /** A refresh token of `url` from instance `h`, with an assertion of `key` when it is given. */
  async function refreshTokenOf(h: Handle, url: string, key: Key | null) {
    const s = await signedIn(h);
    const p = await pkce();
    const { code } = await authorized(h, s.cookie, { clientId: url, challenge: p.challenge });
    const auth: Record<string, string> = key
      ? { client_assertion_type: ASSERTION_TYPE, client_assertion: await assertion(h, key, url) }
      : { client_id: url };
    const res = await h.auth.handle(
      tokenPost({
        grant_type: "authorization_code",
        code,
        code_verifier: p.verifier,
        redirect_uri: "https://client.example.com/callback",
        resource: RESOURCE,
        ...auth,
      }),
    );
    if (res.status !== 200) throw new Error(`exchange answered ${res.status}`);
    return ((await res.json()) as { refresh_token: string }).refresh_token;
  }

  const refresh = (token: string, auth: Record<string, string>) =>
    tokenPost({ grant_type: "refresh_token", refresh_token: token, ...auth });

  it("revokes the refresh tokens of a document that drops from private_key_jwt to none", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { url, key, keyDoc, publicDoc } = await docs();
    const { a, b } = pair(url, keyDoc, publicDoc);
    const token = await refreshTokenOf(a, url, key);
    const rows = await a.storage.findMany("oauthToken", []);
    expect(rows).toHaveLength(1);
    // Instance B reads the public document at this refresh, and the revoke runs in that write.
    const res = await b.auth.handle(refresh(token, { client_id: url }));
    expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_grant" } });
    expect(await b.storage.findMany("oauthToken", [])).toEqual([]);
    // After the commit, the family ends with its mark (ruling 43).
    expect(
      (
        await b.storage.findMany("verification", [
          { field: "purpose", op: "eq", value: "oauth-family-end" },
        ])
      ).map((v) => v.identifier),
    ).toEqual(rows.map((r) => r.familyId));
    expect(
      await b.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: url }]),
    ).toMatchObject({ authMethod: "none" });
    // The client reference, never the document URL (ruling 1 point 2 of plan 12h).
    expect(log.mock.calls).toEqual([
      [DROP_LOG, "cimd:31c67c351206ab0ec26c672384aa30a2", "private_key_jwt", "none"],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(url);
  });

  it("deletes the device codes of a document that drops from private_key_jwt to none (ruling 48)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { url, key, keyDoc, publicDoc } = await docs();
    const grants = { grant_types: ["authorization_code", DEVICE_GRANT] };
    const base = makeAuth();
    const on = (doc: unknown) => {
      const f = fakeFetch();
      f.answers.set(url, () => json(doc));
      return instance(f.fn, base, {});
    };
    const a = on({ ...keyDoc, ...grants });
    const b = on({ ...publicDoc, ...grants });
    const form = (path: string, body: Record<string, string>, headers = {}) =>
      new Request(`${BASE_URL}/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(body).toString(),
      });
    const startOn = async () => {
      const res = await a.auth.handle(
        form("/oauth/device_authorization", {
          client_assertion_type: ASSERTION_TYPE,
          client_assertion: await assertion(a, key, url),
          scope: "mcp:read",
          resource: RESOURCE,
        }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { device_code: string; user_code: string };
    };
    const approved = await startOn();
    await startOn();
    const s = await signedIn(a);
    const done = await a.auth.handle(
      form(
        "/oauth/device",
        { user_code: approved.user_code, decision: "allow" },
        { cookie: s.cookie, origin: BASE_URL },
      ),
    );
    expect(await done.text()).toContain("The device is connected.");
    const poll = { grant_type: DEVICE_GRANT, device_code: approved.device_code, client_id: url };
    // Under the key document, the client id alone is no client auth.
    expect(await answer(await a.auth.handle(tokenPost(poll)))).toEqual({
      status: 400,
      body: { error: "invalid_client" },
    });
    expect((await base.storage.findMany("oauthDevice", [])).length).toBe(2);
    // Instance B reads the public document at this poll, and the drop deletes both device rows.
    a.clock.advance(5_000);
    expect(await answer(await b.auth.handle(tokenPost(poll)))).toEqual({
      status: 400,
      body: { error: "invalid_grant" },
    });
    expect(await base.storage.findMany("oauthDevice", [])).toEqual([]);
    expect(await base.storage.findMany("oauthToken", [])).toEqual([]);
  });

  it("keeps the refresh tokens of a document that keeps its method", async () => {
    const { url, key, keyDoc } = await docs();
    const { a, b, fb } = pair(url, keyDoc, keyDoc);
    const token = await refreshTokenOf(a, url, key);
    const bare = await b.auth.handle(refresh(token, { client_id: url }));
    expect(await answer(bare)).toEqual({ status: 400, body: { error: "invalid_client" } });
    expect(fb.calls).toEqual([url]);
    const res = await b.auth.handle(
      refresh(token, {
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: await assertion(b, key, url),
      }),
    );
    expect(await answer(res)).toEqual({ status: 200, body: null });
  });

  it("keeps the refresh tokens of a document that rises from none to private_key_jwt, and the refresh needs the assertion", async () => {
    const { url, key, keyDoc, publicDoc } = await docs();
    const { a, b } = pair(url, publicDoc, keyDoc);
    const token = await refreshTokenOf(a, url, null);
    const bare = await b.auth.handle(refresh(token, { client_id: url }));
    expect(await answer(bare)).toEqual({ status: 400, body: { error: "invalid_client" } });
    expect(await b.storage.findMany("oauthToken", [])).toHaveLength(1);
    const res = await b.auth.handle(
      refresh(token, {
        client_assertion_type: ASSERTION_TYPE,
        client_assertion: await assertion(b, key, url),
      }),
    );
    expect(await answer(res)).toEqual({ status: 200, body: null });
  });

  it("leaves no gap between the method change and the revoke for a third instance", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { url, key, keyDoc, publicDoc } = await docs();
    const base = makeAuth();
    const on = (doc: unknown) => {
      const f = fakeFetch();
      f.answers.set(url, () => json(doc));
      return instance(f.fn, base);
    };
    // A holds the key document, B reads the public one, and C keeps the key document in its cache.
    const a = on(keyDoc);
    const b = on(publicDoc);
    const c = on(keyDoc);
    const token = await refreshTokenOf(a, url, key);
    await c.auth.handle(refresh("or_unknown", { client_id: url }));
    // C sends a refresh with the client id alone while B's write runs, at the token delete.
    const storage = base.storage;
    const transaction = storage.transaction.bind(storage);
    let racing: Promise<Response> | null = null;
    storage.transaction = (<T>(fn: (tx: typeof storage) => Promise<T>) =>
      transaction((tx) =>
        fn({
          ...tx,
          create: tx.create.bind(tx),
          findOne: tx.findOne.bind(tx),
          findMany: tx.findMany.bind(tx),
          update: tx.update.bind(tx),
          transaction: tx.transaction.bind(tx),
          delete: async (model, where) => {
            if (model === "oauthToken" && racing === null) {
              racing = c.auth.handle(refresh(token, { client_id: url }));
              // Memory runs one transaction at a time: a write of C that needs one waits for B.
              await Promise.race([racing, new Promise((r) => setTimeout(r, 200))]);
            }
            return tx.delete(model, where);
          },
        }),
      )) as typeof storage.transaction;
    try {
      const res = await b.auth.handle(refresh(token, { client_id: url }));
      expect(await answer(res)).toEqual({ status: 400, body: { error: "invalid_grant" } });
    } finally {
      storage.transaction = transaction;
    }
    if (racing === null) throw new Error("no refresh ran in the write");
    expect(await answer(await racing)).toEqual({
      status: 400,
      body: { error: "invalid_client" },
    });
    expect(await base.storage.findMany("oauthToken", [])).toEqual([]);
  });
});
