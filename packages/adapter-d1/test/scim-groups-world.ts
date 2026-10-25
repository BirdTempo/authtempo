import { env } from "cloudflare:test";
import { type AuthConfig, createAuth, type MailMessage } from "@authtempo/core";
import { TABLES } from "@authtempo/core/sql";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The world of the SCIM Groups tests on the D1 binding: the engine, the
// organization acme, and one counted SCIM request. scim-groups-budget.test.ts
// and the named measure measure/scim-groups-list.measure.ts share it (fix wave
// of plan 12i, item 3).

export const API = "https://api.example.com";
export const APP = { kind: "app", name: "budget" } as const;
export const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/** PATCH_MEMBERS_MAX and GROUP_ROLE_USERS_MAX of groups.ts, typed here. */
export const PATCH_CAP = 1000;
export const ROLE_CAP = 1000;

/** A view of `db` that counts each statement, and each statement of a batch. */
export function counting(db: D1Database) {
  const c = { n: 0 };
  const hit = (b: PropertyKey) => b === "run" || b === "all" || b === "first" || b === "raw";
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(a, b) {
        if (b === "bind") return (...v: unknown[]) => wrap(a.bind(...v));
        if (hit(b)) c.n++;
        const x = Reflect.get(a, b);
        return typeof x === "function" ? x.bind(a) : x;
      },
    });
  const counted = new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
      if (k === "batch")
        return (st: D1PreparedStatement[]) => {
          c.n += st.length;
          return t.batch(st);
        };
      const x = Reflect.get(t, k);
      return typeof x === "function" ? x.bind(t) : x;
    },
  });
  return { db: counted as D1Database, c };
}

export const sent: MailMessage[] = [];
/** `membersPerTeam` of the engine: one group by default, and less in the refusal scene. */
export const limits = { membersPerTeam: 10_000 };
export const txt: Record<string, string[]> = {};
export const roleHooks: string[] = [];

/** The engine on `db`. `limited` serves it with the D1 limiter, as worker-d1 does. */
export function make(db: D1Database, limited: boolean, extra: Partial<AuthConfig> = {}) {
  return createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage: createD1Adapter(db),
    limiter: limited ? createD1Limiter(db) : { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    organizations: {
      teams: {},
      dynamicRoles: { maxPerOrganization: 5 },
      // The count of membersPerTeam runs; the bound is one group (GROUP_MEMBERS_MAX).
      limits: { membersPerTeam: limits.membersPerTeam },
    },
    sso: {
      oidc: true,
      dns: [{ name: "a", txt: async (name) => txt[name] ?? [] }],
      fetch: async () => Response.json({}),
    },
    scim: { groups: "both" },
    // The role hooks make the recompute read the users of each role change.
    hooks: {
      organization: {
        beforeUpdateMemberRole: (e) => void roleHooks.push(e.role),
        afterUpdateMemberRole: () => {},
      },
    },
    ...extra,
  });
}

/** A magic link sign-in of `email` on `auth`: the user. */
export async function signIn(auth: ReturnType<typeof make>, email: string) {
  await auth.api.requestMagicLink({ email, ip: null });
  const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
  const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
  const r = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
  if (!r.ok || !("token" in r.value)) throw new Error("no session");
  return r.value.user;
}

/**
 * The organization `acme`: its verified domain, an OIDC connection, the
 * dynamic role `web`, the role map, and a SCIM token.
 */
export async function acme(auth: ReturnType<typeof make>) {
  const owner = await signIn(auth, "owner@acme.example");
  const made = await auth.api.createOrganization({ user: owner, slug: "acme", name: "Acme" });
  if (!made.ok) throw new Error(made.code);
  const organizationId = made.value.organization.id;
  const sso = auth.api.sso;
  const scim = auth.api.scim;
  if (!sso || !scim) throw new Error("no sso or scim api");
  const domain = await sso.domains.add({ actor: APP, organizationId, domain: "acme.example" });
  if (!domain.ok || domain.value.record === null) throw new Error("no domain");
  txt[domain.value.record.name] = [domain.value.record.value];
  if (!(await sso.domains.verify({ actor: APP, id: domain.value.id })).ok)
    throw new Error("no proof");
  const connection = await sso.connections.create({
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
  });
  if (!connection.ok) throw new Error(connection.code);
  const role = await auth.api.createRole({
    user: owner,
    organizationId,
    name: "web",
    permissions: { member: ["read"] },
  });
  if (!role.ok) throw new Error(role.code);
  const map = await scim.setRoleMap({
    actor: APP,
    organizationId,
    map: { Admins: "admin", Web: "web" },
  });
  if (!map.ok) throw new Error(map.code);
  const token = await scim.tokens.create({ actor: APP, organizationId, name: "directory" });
  if (!token.ok) throw new Error(token.code);
  return { organizationId, owner, token: token.value.token };
}

/**
 * One SCIM request: its status, body, and queries. With `worst`, the token
 * was last used two minutes before, as after a pause of the directory. Then
 * the route also writes `lastUsedAt`, the worst case of its steps.
 */
export async function call(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  worst = false,
  limited = true,
) {
  if (worst)
    await env.DB.prepare("UPDATE ta_scim_token SET last_used_at = last_used_at - 120000").run();
  const { db: view, c } = counting(env.DB);
  const res = await make(view, limited).handle(
    new Request(`${API}/auth/scim/v2${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    body: (text === "" ? null : JSON.parse(text)) as Record<string, unknown>,
    queries: c.n,
  };
}

/** `n` SCIM Users of acme: their ids. */
export async function users(token: string, n: number, from = 0) {
  const ids: string[] = [];
  for (let i = from; i < from + n; i++) {
    // With no limiter: the setup sends more Users than the SCIM limit of one token allows.
    const r = await call(
      token,
      "POST",
      "/Users",
      { schemas: [USER_URN], userName: `u${i}@acme.example` },
      false,
      false,
    );
    if (r.status !== 201) throw new Error(`user ${i}: ${r.status} ${JSON.stringify(r.body)}`);
    ids.push(String(r.body.id));
  }
  return ids;
}

export const members = (ids: readonly string[]) => ids.map((value) => ({ value }));
export const patch = (...ops: Record<string, unknown>[]) => ({
  schemas: [PATCH_URN],
  Operations: ops,
});
export const count = async (sql: string) => Number(await env.DB.prepare(sql).first("n"));

/** Empties every table and the state above. Each test file calls it in its beforeEach. */
export async function resetWorld(): Promise<void> {
  await env.DB.batch(Object.values(TABLES).map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  sent.length = 0;
  roleHooks.length = 0;
  limits.membersPerTeam = 10_000;
}
