import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteClient, secretMatches } from "../src/engine/oauth-client-store.js";
import type { ModelName } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { post } from "./helpers.js";
import { codeFor, exchange, type Handle, oauthHandle, REDIRECT } from "./oauth-helpers.js";

/** The SHA-256 hex of a text, computed here, apart from core's own helper. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function clientsOf(h: Handle) {
  const clients = h.auth.api.oauth?.clients;
  if (!clients) throw new Error("oauth is off");
  return clients;
}

/**
 * An Ed25519 key pair made here, as a client publishes it. The public JWK has
 * `alg` EdDSA; the private JWK adds the member `d`.
 */
async function ed25519() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<string, unknown>;
  const pub = { kty: "OKP", crv: "Ed25519", x: priv.x, alg: "EdDSA", use: "sig", kid: "k1" };
  return { pub, priv: { ...pub, d: priv.d } };
}

const METADATA_ERROR = { ok: false, error: "invalid_client_metadata", status: 400 };

/** Every text that core wrote to the console during a test. */
function consoleText(): () => string {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  return () => spies.flatMap((s) => s.mock.calls.flat().map((x) => String(x))).join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api.oauth.clients (plan 12e)", () => {
  it("creates a secret client and shows the secret once", async () => {
    const logged = consoleText();
    const h = oauthHandle();
    const clients = clientsOf(h);
    const made = await clients.create({
      name: "Billing",
      redirectUris: [REDIRECT],
      authMethod: "client_secret_basic",
    });
    if (!made.ok) throw new Error(made.error);
    const secret = made.value.clientSecret ?? "";
    expect(secret).toMatch(/^cs_[A-Za-z0-9_-]{43}$/);
    expect(made.value.client).not.toHaveProperty("secretHash");
    expect(made.value.client).not.toHaveProperty("previousSecretHash");
    expect(made.value.client).toMatchObject({
      id: expect.stringMatching(/^cl_[A-Za-z0-9_-]{43}$/),
      kind: "registered",
      name: "Billing",
      authMethod: "client_secret_basic",
    });
    const row = await h.storage.findOne("oauthClient", [
      { field: "id", op: "eq", value: made.value.client.id },
    ]);
    expect(row?.secretHash).toBe(await sha256(secret));
    const got = await clients.get({ clientId: made.value.client.id });
    expect(got).toEqual({ ok: true, value: made.value.client });
    const listed = await clients.list();
    // No later answer and no log line holds the secret or its hash.
    for (const text of [JSON.stringify(got), JSON.stringify(listed), logged()]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(row?.secretHash ?? "none");
    }
    expect(await clients.get({ clientId: "cl_unknown" })).toEqual({
      ok: false,
      error: "invalid_client",
      status: 401,
    });
  });

  it("creates a private_key_jwt client with jwks and refuses jwks with jwks_uri", async () => {
    const h = oauthHandle();
    const clients = clientsOf(h);
    const { pub, priv } = await ed25519();
    const base = { redirectUris: [REDIRECT], authMethod: "private_key_jwt" as const };
    const made = await clients.create({ ...base, jwks: { keys: [pub] } });
    if (!made.ok) throw new Error(made.error);
    expect(made.value.clientSecret).toBeUndefined();
    expect(made.value.client.jwks).toEqual({ keys: [pub] });
    expect(
      (await clients.create({ ...base, jwksUri: "https://client.example.com/jwks.json" })).ok,
    ).toBe(true);
    for (const bad of [
      // OIDC Registration section 2: never both.
      { jwks: { keys: [pub] }, jwksUri: "https://client.example.com/jwks.json" },
      { jwks: { keys: [priv] } },
      { jwks: { keys: Array.from({ length: 11 }, () => pub) } },
      { jwks: { keys: [] } },
      {},
    ])
      expect(await clients.create({ ...base, ...bad })).toEqual(METADATA_ERROR);
  });

  it("sets credentialsScopes and introspect only in process", async () => {
    const h = oauthHandle();
    const made = await clientsOf(h).create({
      redirectUris: [REDIRECT],
      authMethod: "client_secret_post",
      credentialsScopes: ["mcp:read"],
      introspect: true,
    });
    if (!made.ok) throw new Error(made.error);
    expect(made.value.client).toMatchObject({ credentialsScopes: ["mcp:read"], introspect: true });
    const res = await h.auth.handle(
      post("/auth/oauth/register", {
        redirect_uris: [REDIRECT],
        credentials_scopes: ["mcp:read"],
        introspect: true,
      }),
    );
    expect(res.status).toBe(201);
    const { client_id } = (await res.json()) as { client_id: string };
    expect(
      await h.storage.findOne("oauthClient", [{ field: "id", op: "eq", value: client_id }]),
    ).toMatchObject({ credentialsScopes: [], introspect: false });
  });

  it("refuses a built-in scope as a credentials scope", async () => {
    const clients = clientsOf(oauthHandle());
    for (const scope of ["openid", "profile", "email", "offline_access", "mcp:unknown"])
      expect(
        await clients.create({
          redirectUris: [REDIRECT],
          authMethod: "client_secret_basic",
          credentialsScopes: [scope],
        }),
      ).toEqual(METADATA_ERROR);
  });

  it("lists newest first, 100 at most per page", async () => {
    const h = oauthHandle();
    const clients = clientsOf(h);
    const made: string[] = [];
    for (let i = 0; i < 101; i++) {
      // Two clients share each millisecond, so the page edge falls inside one time.
      if (i % 2 === 0) h.clock.advance(1);
      const r = await clients.create({ redirectUris: [REDIRECT] });
      if (!r.ok) throw new Error(r.error);
      made.push(r.value.client.id);
    }
    const first = await clients.list();
    if (!first.ok) throw new Error(first.error);
    expect(first.value.clients).toHaveLength(100);
    expect(first.value.next).toEqual(expect.any(String));
    const second = await clients.list({ cursor: first.value.next ?? "" });
    if (!second.ok) throw new Error(second.error);
    expect(second.value.clients).toHaveLength(1);
    expect(second.value.next).toBeNull();
    const all = [...first.value.clients, ...second.value.clients];
    expect(new Set(all.map((c) => c.id))).toEqual(new Set(made));
    const times = all.map((c) => c.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(all[0]?.id).toBe(made[100]);
    expect(await clients.list({ limit: 101 })).toMatchObject({
      ok: false,
      error: "invalid_request",
    });
    expect(await clients.list({ cursor: "x" })).toMatchObject({
      ok: false,
      error: "invalid_request",
    });
  });

  it("updates every field but the id, the method, and the secret", async () => {
    const h = oauthHandle();
    const clients = clientsOf(h);
    const made = await clients.create({
      redirectUris: [REDIRECT],
      authMethod: "client_secret_basic",
    });
    if (!made.ok) throw new Error(made.error);
    const clientId = made.value.client.id;
    const before = await h.storage.findOne("oauthClient", [
      { field: "id", op: "eq", value: clientId },
    ]);
    const changed = await clients.update({
      clientId,
      name: "Renamed",
      redirectUris: ["https://client.example.com/other"],
      postLogoutRedirectUris: ["https://client.example.com/bye"],
      grantTypes: ["authorization_code", "refresh_token", "client_credentials"],
      credentialsScopes: ["mcp:write"],
      introspect: true,
      subjectType: "pairwise",
      dpopBound: true,
    });
    expect(changed).toMatchObject({
      ok: true,
      value: {
        id: clientId,
        name: "Renamed",
        authMethod: "client_secret_basic",
        redirectUris: ["https://client.example.com/other"],
        postLogoutRedirectUris: ["https://client.example.com/bye"],
        credentialsScopes: ["mcp:write"],
        introspect: true,
        subjectType: "pairwise",
        dpopBound: true,
      },
    });
    // client_secret_post is a valid method for this client: only the rule of update refuses it.
    for (const bad of [
      { authMethod: "client_secret_post" },
      { secretHash: "0".repeat(64) },
      { id: "cl_x" },
    ])
      expect(await clients.update({ clientId, ...bad } as never)).toEqual(METADATA_ERROR);
    const after = await h.storage.findOne("oauthClient", [
      { field: "id", op: "eq", value: clientId },
    ]);
    expect(after).toMatchObject({
      authMethod: "client_secret_basic",
      secretHash: before?.secretHash,
    });
    expect(await clients.update({ clientId: "cl_unknown", name: "x" })).toMatchObject({
      ok: false,
      error: "invalid_client",
    });
  });

  it("deletes a client with its consents, refresh tokens, device rows, session links, and outbox rows in one transaction", async () => {
    const h = oauthHandle();
    const g = await codeFor(h);
    const res = await h.auth.handle(exchange(g.code, g.clientId, g.verifier));
    expect(res.status).toBe(200);
    const now = h.clock.now();
    // No flow writes these three yet: the device grant (Task 14) and the
    // back-channel logout (Task 16) will. The rows have the shape those flows write.
    const seed = async (clientId: string) => {
      await h.storage.create("oauthDevice", {
        id: `od-${clientId}`,
        deviceCodeHash: await sha256(`device-${clientId}`),
        userCodeHash: await sha256(`user-${clientId}`),
        secretVersion: 1,
        clientId,
        scopes: ["mcp:read"],
        resource: "https://api.example.com/mcp",
        status: "approved",
        userId: g.user.id,
        sessionId: g.session.id,
        interval: 5,
        lastPolledAt: null,
        dpopJkt: null,
        expiresAt: new Date(now.getTime() + 600_000),
        createdAt: now,
        updatedAt: now,
      });
      await h.storage.create("oauthSessionClient", {
        id: `sc-${clientId}`,
        sessionId: g.session.id,
        clientId,
        userId: g.user.id,
        createdAt: now,
        updatedAt: now,
      });
      await h.storage.create("oauthLogout", {
        id: `lo-${clientId}`,
        clientId,
        userId: g.user.id,
        sessionId: g.session.id,
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      });
    };
    await seed(g.clientId);
    const other = await clientsOf(h).create({ redirectUris: [REDIRECT] });
    if (!other.ok) throw new Error(other.error);
    await seed(other.value.client.id);
    const models: ModelName[] = [
      "oauthConsent",
      "oauthToken",
      "oauthDevice",
      "oauthSessionClient",
      "oauthLogout",
    ];
    const count = async (clientId: string) => {
      const out: Record<string, number> = {};
      for (const m of [...models, "oauthClient" as const])
        out[m] = (
          await h.storage.findMany(m, [
            { field: m === "oauthClient" ? "id" : "clientId", op: "eq", value: clientId } as never,
          ])
        ).length;
      return out;
    };
    const full = {
      oauthConsent: 1,
      oauthToken: 1,
      oauthDevice: 1,
      oauthSessionClient: 1,
      oauthLogout: 1,
      oauthClient: 1,
    };
    expect(await count(g.clientId)).toEqual(full);

    // A storage whose transaction throws at the client delete, the last one.
    const failing: StorageAdapter = {
      ...h.storage,
      transaction: (fn) =>
        h.storage.transaction((tx) =>
          fn({
            ...tx,
            delete: async (model, where) => {
              if (model === "oauthClient") throw new Error("storage down");
              return tx.delete(model, where);
            },
          }),
        ),
    };
    await expect(
      deleteClient({ ...h.config, storage: failing }, { clientId: g.clientId }),
    ).rejects.toThrow("storage down");
    expect(await count(g.clientId)).toEqual(full);

    expect(await clientsOf(h).delete({ clientId: g.clientId })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(await count(g.clientId)).toEqual({
      oauthConsent: 0,
      oauthToken: 0,
      oauthDevice: 0,
      oauthSessionClient: 0,
      oauthLogout: 0,
      oauthClient: 0,
    });
    // The other client keeps its rows.
    expect(await count(other.value.client.id)).toMatchObject({
      oauthDevice: 1,
      oauthSessionClient: 1,
      oauthLogout: 1,
      oauthClient: 1,
    });
    expect(await clientsOf(h).delete({ clientId: g.clientId })).toMatchObject({
      ok: false,
      error: "invalid_client",
    });
  });

  it("rotates a secret and keeps the old one for keepOldHours", async () => {
    const logged = consoleText();
    const h = oauthHandle();
    const clients = clientsOf(h);
    const made = await clients.create({
      redirectUris: [REDIRECT],
      authMethod: "client_secret_post",
    });
    if (!made.ok) throw new Error(made.error);
    const clientId = made.value.client.id;
    const oldSecret = made.value.clientSecret ?? "";
    const rotated = await clients.rotateSecret({ clientId, keepOldHours: 2 });
    if (!rotated.ok) throw new Error(rotated.error);
    const newSecret = rotated.value.clientSecret;
    expect(newSecret).toMatch(/^cs_[A-Za-z0-9_-]{43}$/);
    expect(newSecret).not.toBe(oldSecret);
    const until = new Date(h.clock.now().getTime() + 2 * 3_600_000);
    expect(rotated.value.client.previousSecretUntil).toEqual(until);
    const row = async () => {
      const r = await h.storage.findOne("oauthClient", [
        { field: "id", op: "eq", value: clientId },
      ]);
      if (!r) throw new Error("no client row");
      return r;
    };
    expect(await secretMatches(await row(), oldSecret, h.clock.now())).toBe(true);
    expect(await secretMatches(await row(), newSecret, h.clock.now())).toBe(true);
    h.clock.advance(2 * 3_600_000 - 1);
    expect(await secretMatches(await row(), oldSecret, h.clock.now())).toBe(true);
    // Before its time the sweep keeps the old hash.
    expect((await h.auth.api.sweepExpired()).oauthClientSecrets).toBe(0);
    h.clock.advance(2);
    expect(h.clock.now().getTime()).toBe(until.getTime() + 1);
    expect(await secretMatches(await row(), oldSecret, h.clock.now())).toBe(false);
    expect(await secretMatches(await row(), newSecret, h.clock.now())).toBe(true);
    expect(await secretMatches(await row(), "cs_wrong", h.clock.now())).toBe(false);
    expect((await h.auth.api.sweepExpired()).oauthClientSecrets).toBe(1);
    expect(await row()).toMatchObject({ previousSecretHash: null, previousSecretUntil: null });
    for (const keepOldHours of [169, -1, 1.5])
      expect(await clients.rotateSecret({ clientId, keepOldHours })).toEqual(METADATA_ERROR);
    const pub = await clients.create({ redirectUris: [REDIRECT] });
    if (!pub.ok) throw new Error(pub.error);
    expect(await clients.rotateSecret({ clientId: pub.value.client.id })).toEqual(METADATA_ERROR);
    const text = logged();
    expect(text).not.toContain(oldSecret);
    expect(text).not.toContain(newSecret);
  });
});
