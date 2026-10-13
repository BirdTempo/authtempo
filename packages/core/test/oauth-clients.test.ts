import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findClient,
  registerClient,
  validCimdUrl,
  validRedirectUri,
} from "../src/engine/oauth-clients.js";
import type { OAuthClientRow } from "../src/schema.js";
import { StorageError } from "../src/storage/port.js";
import { BASE_URL, makeAuth, post } from "./helpers.js";
import { oauthHandle, REDIRECT, RESOURCE } from "./oauth-helpers.js";

const DOC_URL = "https://client.example.com/oauth/metadata.json";
const doc = (over: Record<string, unknown> = {}) => ({
  client_id: DOC_URL,
  client_name: "Doc client",
  redirect_uris: ["https://client.example.com/cb"],
  token_endpoint_auth_method: "none",
  ...over,
});
const jsonDoc = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A fetch that answers `answer()` and records each call. */
function docFetch(answer: () => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const cimdAuth = (fetch: typeof globalThis.fetch) =>
  makeAuth({ oauth: { resources: [RESOURCE], fetch } });
const dynAuth = () => makeAuth({ oauth: { resources: [RESOURCE], registration: { cimd: false } } });
let ipN = 0;
/** Each call from its own IP unless the test names one, so the register limit counts only where a test asks. */
const meta = (metadata: Record<string, unknown>, ip = `10.0.0.${++ipN}`) => ({ metadata, ip });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("client registration, RFC 7591 (plan 9g)", () => {
  it("registers a public client: a cl_ id, the echo, and a registered row", async () => {
    const auth = dynAuth();
    const r = await registerClient(
      auth.config,
      meta({ redirect_uris: ["https://client.example.com/cb"], client_name: "My agent" }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toEqual({
      client_id: expect.stringMatching(/^cl_[A-Za-z0-9_-]{43}$/),
      client_id_issued_at: Math.floor(auth.clock.now().getTime() / 1000),
      client_name: "My agent",
      redirect_uris: ["https://client.example.com/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(
      await auth.storage.findOne("oauthClient", [
        { field: "id", op: "eq", value: r.value.client_id },
      ]),
    ).toMatchObject({
      kind: "registered",
      name: "My agent",
      redirectUris: ["https://client.example.com/cb"],
    });
    expect(await findClient(auth.config, r.value.client_id)).toMatchObject({
      id: r.value.client_id,
    });
    expect(await findClient(auth.config, `cl_${"A".repeat(43)}`)).toBeNull();
  });

  it("takes https, a loopback http with any port, and a private-use scheme; refuses the rest", () => {
    for (const uri of [
      "https://client.example.com/cb",
      "https://client.example.com/cb?x=1",
      "http://127.0.0.1:5173/cb",
      "http://localhost:1/cb",
      "com.example.app:/callback",
      "myapp://callback",
    ])
      expect({ uri, ok: validRedirectUri(uri) }).toEqual({ uri, ok: true });
    for (const uri of [
      "http://client.example.com/cb",
      // The consent page policy cannot name an IPv6 literal in form-action.
      "http://[::1]:9/cb",
      "https://client.example.com/cb#frag",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "relative/path",
      "https://user:pw@client.example.com/cb",
      `https://client.example.com/${"a".repeat(2048)}`,
      "https://client.example.com/c\nb",
      42,
    ])
      expect({ uri, ok: validRedirectUri(uri) }).toEqual({ uri, ok: false });
  });

  it("answers invalid_redirect_uri and invalid_client_metadata, and writes no row", async () => {
    const auth = dynAuth();
    for (const m of [
      {},
      { redirect_uris: [] },
      { redirect_uris: "https://a.example.com/cb" },
      { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example.com/${i}`) },
      { redirect_uris: ["http://a.example.com/cb"] },
    ])
      expect(await registerClient(auth.config, meta(m))).toEqual({
        ok: false,
        error: "invalid_redirect_uri",
        status: 400,
      });
    const good = { redirect_uris: ["https://a.example.com/cb"] };
    for (const m of [
      { ...good, token_endpoint_auth_method: "client_secret_basic" },
      { ...good, grant_types: ["implicit"] },
      { ...good, response_types: ["token"] },
      { ...good, client_name: "" },
      { ...good, client_name: "x".repeat(81) },
      { ...good, client_name: "a\u0007" },
    ])
      expect(await registerClient(auth.config, meta(m))).toEqual({
        ok: false,
        error: "invalid_client_metadata",
        status: 400,
      });
    expect(await auth.storage.findMany("oauthClient", [])).toEqual([]);
  });

  it("limits registration to 10 per IP per hour", async () => {
    const auth = dynAuth();
    const m = { redirect_uris: ["https://a.example.com/cb"] };
    for (let i = 0; i < 10; i++)
      expect((await registerClient(auth.config, meta(m, "9.9.9.9"))).ok).toBe(true);
    expect(await registerClient(auth.config, meta(m, "9.9.9.9"))).toEqual({
      ok: false,
      error: "rate_limited",
      status: 429,
    });
  });

  it("moves a registered client's lastSeenAt at most once a day", async () => {
    const auth = dynAuth();
    const r = await registerClient(
      auth.config,
      meta({ redirect_uris: ["https://a.example.com/cb"] }),
    );
    if (!r.ok) throw new Error(r.error);
    const id = r.value.client_id;
    const seen = async () =>
      (await auth.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: id }]))
        ?.lastSeenAt;
    const first = auth.clock.now();
    auth.clock.advance(86_400_000 - 1);
    expect((await findClient(auth.config, id))?.lastSeenAt).toEqual(first);
    expect(await seen()).toEqual(first);
    auth.clock.advance(1);
    expect((await findClient(auth.config, id))?.lastSeenAt).toEqual(auth.clock.now());
    expect(await seen()).toEqual(auth.clock.now());
  });

  it("POST /oauth/register answers 201 with the client, 400 with the RFC 7591 error, and 404 while registration is off", async () => {
    const h = oauthHandle();
    const made = await h.auth.handle(
      post("/auth/oauth/register", { redirect_uris: [REDIRECT], client_name: "Agent" }),
    );
    expect(made.status).toBe(201);
    expect(made.headers.get("cache-control")).toBe("no-store");
    expect(await made.json()).toMatchObject({
      client_name: "Agent",
      token_endpoint_auth_method: "none",
    });
    const bad = await h.auth.handle(
      post("/auth/oauth/register", { redirect_uris: ["http://evil.example.com/cb"] }),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_redirect_uri" });
    const notJson = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[",
      }),
    );
    expect(await notJson.json()).toEqual({ error: "invalid_client_metadata" });
    const fetch = (async () => new Response()) as typeof globalThis.fetch;
    const off = oauthHandle({
      oauth: { resources: [RESOURCE], registration: { dynamic: false }, fetch },
    });
    expect(
      (await off.auth.handle(post("/auth/oauth/register", { redirect_uris: [REDIRECT] }))).status,
    ).toBe(404);
    const none = oauthHandle({ oauth: false });
    expect(
      (await none.auth.handle(post("/auth/oauth/register", { redirect_uris: [REDIRECT] }))).status,
    ).toBe(404);
  });
});

describe("client ID metadata documents (plan 9g)", () => {
  it("reads the document through oauth.fetch, writes a cimd row, and keeps the document one hour", async () => {
    const f = docFetch(() => jsonDoc(doc()));
    const auth = cimdAuth(f.fetch);
    expect(await findClient(auth.config, DOC_URL)).toMatchObject({
      id: DOC_URL,
      kind: "cimd",
      name: "Doc client",
      redirectUris: ["https://client.example.com/cb"],
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(DOC_URL);
    expect(f.calls[0]?.init).toMatchObject({
      redirect: "manual",
      headers: { accept: "application/json" },
    });
    await findClient(auth.config, DOC_URL);
    expect(f.calls).toHaveLength(1);
    auth.clock.advance(3_600_000);
    await findClient(auth.config, DOC_URL);
    expect(f.calls).toHaveLength(2);
    expect(await auth.storage.findMany("oauthClient", [])).toHaveLength(1);
  });

  it("refuses a document that names another client_id, and writes no client row", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = docFetch(() => jsonDoc(doc({ client_id: "https://evil.example.com/meta.json" })));
    const auth = cimdAuth(f.fetch);
    expect(await findClient(auth.config, DOC_URL)).toBeNull();
    expect(await auth.storage.findMany("oauthClient", [])).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "tempo-auth: client metadata document refused",
      "client_id is not the document URL",
    );
  });

  it("refuses a document over 64 KB, another content type, a status other than 200, a secret method, and a bad redirect URI", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const big = JSON.stringify(doc({ padding: "x".repeat(65 * 1024) }));
    const answers = [
      () => new Response(big, { status: 200, headers: { "content-type": "application/json" } }),
      () =>
        new Response(JSON.stringify(doc()), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      () =>
        new Response(null, { status: 302, headers: { location: "https://other.example.com/" } }),
      () => jsonDoc(doc({ token_endpoint_auth_method: "client_secret_post" })),
      () => jsonDoc(doc({ redirect_uris: ["http://client.example.com/cb"] })),
      () => jsonDoc(["not", "an", "object"]),
    ];
    for (const [i, answer] of answers.entries()) {
      const auth = cimdAuth(docFetch(answer).fetch);
      expect({ i, client: await findClient(auth.config, DOC_URL) }).toEqual({ i, client: null });
      expect(await auth.storage.findMany("oauthClient", [])).toEqual([]);
    }
  });

  it("fetches nothing for a client id that is not an https URL with a path", async () => {
    const f = docFetch(() => jsonDoc(doc()));
    const auth = cimdAuth(f.fetch);
    for (const id of [
      "http://client.example.com/meta.json",
      "https://client.example.com",
      "https://client.example.com/",
      "https://client.example.com/meta.json?x=1",
      "https://client.example.com/meta.json#a",
      "https://u:p@client.example.com/meta.json",
      "https://client.example.com/a/../meta.json",
      // Not canonical: each parses to /b/meta.json.
      "https://client.example.com/a/%2e%2e/b/meta.json",
      "https://client.example.com/a/.%2E/b/meta.json",
      "https://client.example.com/a\\..\\b/meta.json",
      // Hosts that only an internal network reaches, and this instance's own host.
      "https://127.0.0.1/meta.json",
      "https://10.0.0.1/meta.json",
      "https://[::1]/meta.json",
      "https://localhost/meta.json",
      "https://localhost./meta.json",
      "https://app.localhost/meta.json",
      "https://intranet/meta.json",
      "https://api.example.com/meta.json",
      "not a url",
    ])
      expect({ id, client: await findClient(auth.config, id) }).toEqual({ id, client: null });
    expect(f.calls).toEqual([]);
  });

  it("takes a public host in canonical form, with a port too", () => {
    for (const id of [DOC_URL, "https://client.example.com:8443/meta.json"])
      expect({ id, ok: validCimdUrl(id, BASE_URL) }).toEqual({ id, ok: true });
  });

  it("refuses each host rule on its own", () => {
    for (const id of [
      "https://127.0.0.1/meta.json",
      "https://[::1]/meta.json",
      "https://localhost/meta.json",
      "https://app.localhost/meta.json",
      "https://intranet/meta.json",
      "https://api.example.com/meta.json",
      "https://Client.example.com/meta.json",
    ])
      expect({ id, ok: validCimdUrl(id, BASE_URL) }).toEqual({ id, ok: false });
  });

  it("refuses the hosts that only a local network resolves: .local, .home.arpa, and .internal (final fix wave)", () => {
    for (const id of [
      "https://printer.local/meta.json",
      "https://nas.home.arpa/meta.json",
      "https://home.arpa/meta.json",
      "https://svc.corp.internal/meta.json",
      "https://svc.internal./meta.json",
    ])
      expect({ id, ok: validCimdUrl(id, BASE_URL) }).toEqual({ id, ok: false });
    // A label that only looks like a suffix is a public name.
    for (const id of [
      "https://internal.example.com/meta.json",
      "https://local.example.com/meta.json",
      "https://myhome.arpa.example.com/meta.json",
    ])
      expect({ id, ok: validCimdUrl(id, BASE_URL) }).toEqual({ id, ok: true });
  });

  it("refuses this instance's own host on any port: the compare is by hostname (final fix wave)", () => {
    expect(validCimdUrl("https://api.example.com:8443/meta.json", BASE_URL)).toBe(false);
    expect(validCimdUrl("https://api.example.com/meta.json", "https://api.example.com:8443")).toBe(
      false,
    );
    expect(validCimdUrl("https://api2.example.com/meta.json", "https://api.example.com:8443")).toBe(
      true,
    );
  });

  it("a create that loses the unique key reads the winner's row: this document's values, the winner's createdAt (final fix wave)", async () => {
    const auth = cimdAuth(docFetch(() => jsonDoc(doc())).fetch);
    const earlier = new Date(auth.clock.now().getTime() - 60_000);
    const create = auth.storage.create.bind(auth.storage);
    let lost = 0;
    // A parallel request writes the row between this call's read and its create.
    auth.storage.create = (async (model: string, data: Record<string, unknown>) => {
      if (model === "oauthClient" && lost === 0) {
        lost++;
        await create("oauthClient", {
          ...(data as unknown as OAuthClientRow),
          name: "Winner name",
          createdAt: earlier,
        });
        throw new StorageError("unique_violation", "oauthClient", ["id"]);
      }
      return create(model as "oauthClient", data as unknown as OAuthClientRow);
    }) as typeof auth.storage.create;
    const row = await findClient(auth.config, DOC_URL);
    expect(lost).toBe(1);
    expect(row).toMatchObject({ id: DOC_URL, name: "Doc client", createdAt: earlier });
    expect(await auth.storage.findMany("oauthClient", [])).toEqual([row]);
  });

  it("writes one row when two requests read the same new document at once", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let calls = 0;
    const fetch = (async () => {
      calls++;
      await gate;
      return jsonDoc(doc());
    }) as typeof globalThis.fetch;
    const auth = cimdAuth(fetch);
    const both = Promise.all([findClient(auth.config, DOC_URL), findClient(auth.config, DOC_URL)]);
    open();
    const [a, b] = await both;
    expect(calls).toBe(2);
    expect(a).toMatchObject({ id: DOC_URL, kind: "cimd" });
    expect(b).toEqual(a);
    expect(await auth.storage.findMany("oauthClient", [])).toHaveLength(1);
  });

  it("keeps at most 500 documents, and the oldest goes first", async () => {
    const calls: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonDoc(doc({ client_id: String(input) }));
    }) as typeof globalThis.fetch;
    const auth = cimdAuth(fetch);
    const url = (i: number) => `https://client.example.com/m/${i}.json`;
    for (let i = 0; i <= 500; i++) expect(await findClient(auth.config, url(i))).not.toBeNull();
    expect(auth.config.oauth?.cimdCache.size).toBe(500);
    expect(auth.config.oauth?.cimdCache.has(url(0))).toBe(false);
    await findClient(auth.config, url(1));
    expect(calls).toHaveLength(501);
    await findClient(auth.config, url(0));
    expect(calls).toHaveLength(502);
  });

  it("gives up after 10 seconds, on a fetch that never answers and on a body that stops", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hang = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof globalThis.fetch;
    const stall = (async () =>
      new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    for (const fetch of [hang, stall]) {
      const auth = cimdAuth(fetch);
      let settled = false;
      const pending = findClient(auth.config, DOC_URL).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBeNull();
    }
  });
});
