import { env } from "cloudflare:test";
import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { beforeEach, describe, expect, it } from "vitest";
import { createD1Adapter } from "../src/index.js";

// The races of plan 12d on D1, through createAuth (Task 10, Review Focus 4).
// Each race runs two requests at once with Promise.all. D1 has no row lock
// and no isolation (README, "Transactions"): the unique keys and the
// conditional updates decide the winner. The rows that stay show one winner:
// one claim of a domain, one claim of an address, one SCIM user, and one
// spent version. The race of the member limit runs on Postgres, which locks.

const API = "https://api.example.com";
const APP = { kind: "app", name: "race" } as const;
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

beforeEach(async () => {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

/**
 * The engine with organizations, OIDC connections, SCIM, and the password,
 * on `storage`. The fake DNS answers from `txt`. The fake IdP answers the
 * code as the ID token, and the jwt seam knows the tokens of `idTokens`.
 */
function world(storage: StorageAdapter, membersPerOrganization?: number) {
  const sent: MailMessage[] = [];
  const txt: Record<string, string[]> = {};
  const idTokens: Record<string, Record<string, unknown>> = {};
  const dns = (name: string) => ({ name, txt: async (asked: string) => txt[asked] ?? [] });
  let verifies = 0;
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    password: { requireVerified: false, uniformSignUp: false },
    organizations:
      membersPerOrganization === undefined ? {} : { limits: { membersPerOrganization } },
    sso: {
      oidc: true,
      dns: [dns("a"), dns("b")],
      fetch: async (_url, init) => {
        const body = typeof init?.body === "string" ? init.body : "";
        return Response.json({
          id_token: new URLSearchParams(body).get("code"),
          token_type: "Bearer",
        });
      },
    },
    scim: {},
    hooks: { user: { afterVerify: () => void verifies++ } },
    jwt: {
      verifyIdToken: async (input) => {
        const claims = idTokens[input.token];
        if (!claims) throw new Error("fake jwt: verify failed");
        return claims;
      },
      signES256: async () => "es256",
    },
  });
  const must = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const api = () => {
    const sso = auth.api.sso;
    const scim = auth.api.scim;
    if (!sso || !scim) throw new Error("no sso or scim api");
    return { sso, scim };
  };
  const lastToken = (to: string) => {
    const text = sent.filter((m) => m.to === to).at(-1)?.text ?? "";
    return decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  };
  /** A verified user and its session, by a magic link. */
  async function signIn(email: string) {
    must(await auth.api.requestMagicLink({ email, ip: null }));
    const r = must(
      await auth.api.verifyMagicLink({ token: lastToken(email), ip: null, userAgent: null }),
    );
    if (!("token" in r)) throw new Error("a challenge");
    return r;
  }
  /** An organization of a new owner. */
  async function organization(slug: string) {
    const owner = await signIn(`owner@${slug}.example`);
    return must(await auth.api.createOrganization({ user: owner.user, slug, name: slug }))
      .organization.id;
  }
  /** A domain add of the organization, with its record on both resolvers when `publish`. */
  async function domain(organizationId: string, name: string, publish = true) {
    const added = must(await api().sso.domains.add({ actor: APP, organizationId, domain: name }));
    if (added.record === null) throw new Error("no record");
    if (publish) txt[added.record.name] = [...(txt[added.record.name] ?? []), added.record.value];
    return added.id;
  }
  /** The organization `acme` with its verified domain, one OIDC connection, and a SCIM token. */
  async function acme() {
    const organizationId = await organization("acme");
    must(
      await api().sso.domains.verify({
        actor: APP,
        id: await domain(organizationId, "acme.example"),
      }),
    );
    const connection = must(
      await api().sso.connections.create({
        actor: APP,
        organizationId,
        kind: "oidc",
        label: "Acme IdP",
        issuer: "https://login.acme-idp.example",
        clientId: "acme-client",
        clientSecret: "acme-secret-0123456789",
        endpoints: {
          authorizeUrl: "https://login.acme-idp.example/authorize",
          tokenUrl: "https://login.acme-idp.example/token",
          jwksUrl: "https://login.acme-idp.example/keys",
        },
      }),
    ).id;
    const token = must(
      await api().scim.tokens.create({ actor: APP, organizationId, name: "directory" }),
    ).token;
    return { organizationId, connection, token };
  }
  /**
   * One SSO sign-in through the start and the callback. It answers the
   * `auth_error` of its redirect, null for a redirect with none, or the
   * status of another answer.
   */
  async function ssoSignIn(connection: string, sub: string, email: string) {
    const started = await auth.handle(new Request(`${API}/auth/sso/${connection}/start`));
    const url = new URL(started.headers.get("location") ?? "");
    const bind = started.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Secure-tempo_session_oauth="))
      ?.split(";")[0];
    const code = `code-${sub}-${crypto.randomUUID()}`;
    idTokens[code] = { sub, email, nonce: url.searchParams.get("nonce") ?? "" };
    const q = new URLSearchParams({ code, state: url.searchParams.get("state") ?? "" });
    const res = await auth.handle(
      new Request(`${API}/auth/sso/${connection}/callback?${q}`, {
        headers: { cookie: bind ?? "" },
      }),
    );
    // Only a redirect is an answer of the flow. Any other status is a fault.
    if (res.status !== 302) return `status ${res.status}`;
    return new URL(res.headers.get("location") ?? "", API).searchParams.get("auth_error");
  }
  /** One SCIM request with the bearer `token`: its status and its body. */
  async function scim(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await auth.handle(
      new Request(`${API}/auth/scim/v2${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await res.text();
    return {
      status: res.status,
      body: (text === "" ? null : JSON.parse(text)) as Record<string, unknown>,
    };
  }
  return {
    auth,
    must,
    api,
    txt,
    signIn,
    organization,
    domain,
    acme,
    ssoSignIn,
    scim,
    lastToken,
    verifies: () => verifies,
  };
}

/**
 * A storage whose reads of the scimUser row outside a transaction wait, once
 * armed, until `n` reads have arrived. Two requests then read the same
 * version before either writes, the interleave of a real race.
 */
function readGate(base: StorageAdapter) {
  let waiting: (() => void)[] = [];
  let left = 0;
  const storage: StorageAdapter = {
    ...base,
    async findOne(model, where) {
      const row = await base.findOne(model, where);
      if (model === "scimUser" && left > 0) {
        left--;
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (left === 0) {
            for (const go of waiting) go();
            waiting = [];
          }
        });
      }
      return row;
    },
  };
  const arm = (n: number) => {
    left = n;
  };
  return { storage, arm };
}

const count = async (table: string, where = "1 = 1") =>
  Number(await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first("n"));

describe("the races of plan 12d on D1 (Task 10)", () => {
  it("gives a domain to one organization in a race", async () => {
    const w = world(createD1Adapter(env.DB));
    const one = await w.domain(await w.organization("one"), "acme.example");
    const two = await w.domain(await w.organization("two"), "acme.example");
    const answers = await Promise.all([
      w.api().sso.domains.verify({ actor: APP, id: one }),
      w.api().sso.domains.verify({ actor: APP, id: two }),
    ]);
    expect(answers.map((r) => (r.ok ? "ok" : r.code)).sort()).toEqual(["domain_taken", "ok"]);
    expect(await count("ta_sso_domain", "claimed_domain = 'acme.example'")).toBe(1);
  }, 30_000);

  it("wins one claim between an SSO sign-in and a magic link", async () => {
    const w = world(createD1Adapter(env.DB));
    const { connection } = await w.acme();
    const password = w.auth.api.password;
    if (!password) throw new Error("no password api");
    const up = w.must(
      await password.signUp({
        email: "ada@acme.example",
        password: "a claimant's password",
        ip: null,
        userAgent: null,
      }),
    );
    if (!("token" in up)) throw new Error("the sign-up opened no session");
    w.must(await w.auth.api.requestMagicLink({ email: "ada@acme.example", ip: null }));
    const link = w.lastToken("ada@acme.example");
    const before = w.verifies();
    const [sso, mailed] = await Promise.all([
      w.ssoSignIn(connection, "a-1", "ada@acme.example"),
      w.auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null }),
    ]);
    // On D1 a claim runs once (ruling 32 of plan 12n). The proof that loses
    // the flip answers conflict, and its client sends it again. A proof that
    // reads the user after the other commits signs in with no claim.
    const outcomes = [sso ?? "ok", mailed.ok ? "ok" : mailed.code].sort();
    expect([
      ["conflict", "ok"],
      ["ok", "ok"],
    ]).toContainEqual(outcomes);
    // One claim. The claimant's session is gone.
    expect(w.verifies() - before).toBe(1);
    expect(await w.auth.api.getSession(up.token)).toBeNull();
    expect(await count("ta_password")).toBe(0);
  }, 30_000);

  it("creates one SCIM user for two creates of one userName", async () => {
    const w = world(createD1Adapter(env.DB));
    const { token } = await w.acme();
    const body = { schemas: [USER_URN], userName: "ada@acme.example" };
    const answers = await Promise.all([
      w.scim(token, "POST", "/Users", body),
      w.scim(token, "POST", "/Users", body),
    ]);
    expect(answers.map((a) => [a.status, a.body.scimType]).sort()).toEqual([
      [201, undefined],
      [409, "uniqueness"],
    ]);
    expect(await count("ta_scim_user")).toBe(1);
    expect(await count("ta_user", "email = 'ada@acme.example'")).toBe(1);
  }, 30_000);

  it("spends one version for two patches", async () => {
    // Both patches read the row before either writes: the gate holds each read of
    // the scimUser row outside a transaction until two have arrived.
    const gate = readGate(createD1Adapter(env.DB));
    const w = world(gate.storage);
    const { token } = await w.acme();
    const made = await w.scim(token, "POST", "/Users", {
      schemas: [USER_URN],
      userName: "ada@acme.example",
    });
    const id = String(made.body.id);
    const change = (name: string) => ({
      schemas: [PATCH_URN],
      Operations: [{ op: "replace", path: "displayName", value: name }],
    });
    gate.arm(2);
    const answers = await Promise.all(
      ["One", "Two"].map((name) =>
        w.scim(token, "PATCH", `/Users/${id}`, change(name), { "if-match": 'W/"1"' }),
      ),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([200, 412]);
    expect(await env.DB.prepare("SELECT version FROM ta_scim_user").first("version")).toBe(2);
  }, 30_000);
});
