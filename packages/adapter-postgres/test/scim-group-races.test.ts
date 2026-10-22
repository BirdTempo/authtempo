import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The races of the SCIM Groups on Postgres (ruling 59 of plan 12d, M1 and
// M2). Two engines share one database, each on its own storage wrapper.
// The wrappers stop one transaction at a named step until the other request
// ends, or until a time-out when the other request waits on a lock of the
// first. The rows that stay show that the two writes ran one at a time.

const API = "https://api.example.com";
const APP = { kind: "app", name: "race" } as const;
const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
/** The longest wait at a stop: the other request waits on a lock of this one. */
const WAIT_MS = 1500;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

/** A promise and its resolve. */
function signal() {
  let fire: () => void = () => {};
  const fired = new Promise<void>((r) => {
    fire = r;
  });
  return { fire, fired };
}

/** `p`, or the end of `ms`. */
const within = (p: Promise<unknown>, ms = WAIT_MS) =>
  Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/**
 * The adapter on the test database, with `tap` on each transaction handle.
 * `tap` gets the handle and the name of a call, and runs after the call.
 */
function tapped(tap: (method: string, model: string) => Promise<void>): StorageAdapter {
  const base = createPostgresAdapter(db.sql);
  const wrap = (tx: StorageAdapter): StorageAdapter =>
    new Proxy(tx, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (typeof v !== "function" || typeof p !== "string") return v;
        return async (...args: unknown[]) => {
          const out = await (v as (...a: unknown[]) => Promise<unknown>).apply(t, args);
          await tap(p, String(args[0]));
          return out;
        };
      },
    }) as StorageAdapter;
  return new Proxy(base, {
    get(t, p) {
      if (p === "transaction")
        return <R>(fn: (tx: StorageAdapter) => Promise<R>) => t.transaction((tx) => fn(wrap(tx)));
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as StorageAdapter;
}

/** The engine with organizations, an OIDC connection, and SCIM, on `storage`. */
function world(storage: StorageAdapter) {
  const sent: MailMessage[] = [];
  const txt: Record<string, string[]> = {};
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: { allow: async () => true },
    mail: { send: async (m) => void sent.push(m) },
    password: { requireVerified: false, uniformSignUp: false },
    organizations: {},
    sso: {
      oidc: true,
      dns: [{ name: "a", txt: async (asked: string) => txt[asked] ?? [] }],
      fetch: async () => Response.json({}),
    },
    scim: { groups: "roles" },
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
  /** The organization `acme`: its owner, its verified domain, one connection, and a SCIM token. */
  async function acme() {
    const email = "owner@acme.example";
    must(await auth.api.requestMagicLink({ email, ip: null }));
    const text = sent.filter((m) => m.to === email).at(-1)?.text ?? "";
    const link = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const owner = must(await auth.api.verifyMagicLink({ token: link, ip: null, userAgent: null }));
    if (!("token" in owner)) throw new Error("a challenge");
    const organizationId = must(
      await auth.api.createOrganization({ user: owner.user, slug: "acme", name: "Acme" }),
    ).organization.id;
    const added = must(
      await api().sso.domains.add({ actor: APP, organizationId, domain: "acme.example" }),
    );
    if (added.record === null) throw new Error("no record");
    txt[added.record.name] = [added.record.value];
    must(await api().sso.domains.verify({ actor: APP, id: added.id }));
    must(
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
    );
    must(await api().scim.setRoleMap({ actor: APP, organizationId, map: { Admins: "admin" } }));
    const token = must(
      await api().scim.tokens.create({ actor: APP, organizationId, name: "directory" }),
    ).token;
    return { organizationId, token };
  }
  /** One SCIM request with the bearer `token`: its status and its body. */
  async function scim(token: string, method: string, path: string, body?: unknown) {
    const res = await auth.handle(
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
    };
  }
  return { acme, scim };
}

const patch = (...ops: Record<string, unknown>[]) => ({ schemas: [PATCH_URN], Operations: ops });
const count = async (table: string, where = "TRUE") =>
  Number((await db.sql.unsafe(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0]?.n);

/** The role of ada's member row of acme, or null. */
async function adaRole(): Promise<string | null> {
  const rows = await db.sql.unsafe(
    "SELECT m.role FROM ta_member m JOIN ta_user u ON u.id = m.user_id WHERE u.email = 'ada@acme.example'",
  );
  return (rows[0]?.role as string | undefined) ?? null;
}

/**
 * Acme with ada in the mapped group Admins, through `w`: the ids of ada and
 * of the group. `active: false` deactivates ada after the group create.
 */
async function adminsWithAda(w: ReturnType<typeof world>, token: string, active = true) {
  const ada = String(
    (await w.scim(token, "POST", "/Users", { schemas: [USER_URN], userName: "ada@acme.example" }))
      .body.id,
  );
  const made = await w.scim(token, "POST", "/Groups", {
    schemas: [GROUP_URN],
    displayName: "Admins",
    members: [{ value: ada }],
  });
  expect(made.status).toBe(201);
  expect(await adaRole()).toBe("admin");
  if (!active) {
    const off = await w.scim(
      token,
      "PATCH",
      `/Users/${ada}`,
      patch({ op: "replace", path: "active", value: false }),
    );
    expect(off.status).toBe(200);
    expect(await adaRole()).toBeNull();
  }
  return { ada, group: String(made.body.id) };
}

describe("the SCIM Groups on Postgres (ruling 59 of plan 12d)", () => {
  it("runs a mapped group remove and a User delete of one person with no deadlock (M1)", async () => {
    // The group remove stops after its member row lock, until the User delete has
    // written the scimGroupMember rows. The two orders of these rows formed a cycle.
    let armed = false;
    const locked = signal();
    const dropped = signal();
    const forGroup = tapped(async (method, model) => {
      if (armed && method === "lockInOrder" && model === "member") {
        locked.fire();
        await within(dropped.fired);
      }
    });
    const forUser = tapped(async (method, model) => {
      if (armed && method === "delete" && model === "scimGroupMember") dropped.fire();
    });
    const g = world(forGroup);
    const u = world(forUser);
    const { token } = await g.acme();
    const { ada, group } = await adminsWithAda(g, token);
    armed = true;
    const answers = await Promise.all([
      g.scim(
        token,
        "PATCH",
        `/Groups/${group}`,
        patch({ op: "remove", path: "members", value: [{ value: ada }] }),
      ),
      (async () => {
        await within(locked.fired);
        return u.scim(token, "DELETE", `/Users/${ada}`);
      })(),
    ]);
    // No deadlock (500). The group write changed ada's role after the delete read the
    // member row, so the delete answers 409, and the directory sends it again.
    expect(answers.map((a) => a.status)).toEqual([204, 409]);
    expect(await adaRole()).toBe("member");
    expect((await u.scim(token, "DELETE", `/Users/${ada}`)).status).toBe(204);
    expect(await count("ta_scim_user")).toBe(0);
    expect(await count("ta_scim_group_member")).toBe(0);
    expect(await adaRole()).toBeNull();
  }, 60_000);

  it("gives the role of the new groups when a removal commits between the reactivate's read and its hold (M2)", async () => {
    // The reactivate stops after its first read of the groups, before its user hold,
    // until the removal from Admins ends. Then its read after the hold sees the change.
    let armed = false;
    const read = signal();
    const removed = signal();
    const forUser = tapped(async (method, model) => {
      if (armed && method === "findMany" && model === "scimGroupMember") {
        armed = false;
        read.fire();
        await within(removed.fired);
      }
    });
    const g = world(createPostgresAdapter(db.sql));
    const u = world(forUser);
    const { token } = await g.acme();
    const { ada, group } = await adminsWithAda(g, token, false);
    armed = true;
    const answers = await Promise.all([
      u.scim(
        token,
        "PATCH",
        `/Users/${ada}`,
        patch({ op: "replace", path: "active", value: true }),
      ),
      (async () => {
        await within(read.fired, 10_000);
        const r = await g.scim(
          token,
          "PATCH",
          `/Groups/${group}`,
          patch({ op: "remove", path: `members[value eq "${ada}"]` }),
        );
        removed.fire();
        return r;
      })(),
    ]);
    // The before hook of the reactivate saw the old role, so it answers 409.
    expect(answers.map((a) => a.status)).toEqual([409, 204]);
    expect(await adaRole()).toBeNull();
    // The directory sends the reactivate again, and the role is the one of the new groups.
    const again = await u.scim(
      token,
      "PATCH",
      `/Users/${ada}`,
      patch({ op: "replace", path: "active", value: true }),
    );
    expect(again.status).toBe(200);
    expect(await adaRole()).toBe("member");
  }, 60_000);

  it("gives the role of the new groups when a removal starts after the reactivate's hold (M2)", async () => {
    // The reactivate stops after its read of the groups under the user hold. The
    // removal holds ada too, so it waits for the reactivate, then reads its member row.
    let reads = 0;
    let armed = false;
    const held = signal();
    const removed = signal();
    const forUser = tapped(async (method, model) => {
      if (armed && method === "findMany" && model === "scimGroupMember" && ++reads === 2) {
        armed = false;
        held.fire();
        await within(removed.fired);
      }
    });
    const g = world(createPostgresAdapter(db.sql));
    const u = world(forUser);
    const { token } = await g.acme();
    const { ada, group } = await adminsWithAda(g, token, false);
    armed = true;
    const answers = await Promise.all([
      u.scim(
        token,
        "PATCH",
        `/Users/${ada}`,
        patch({ op: "replace", path: "active", value: true }),
      ),
      (async () => {
        await within(held.fired, 10_000);
        const r = await g.scim(
          token,
          "PATCH",
          `/Groups/${group}`,
          patch({ op: "remove", path: `members[value eq "${ada}"]` }),
        );
        removed.fire();
        return r;
      })(),
    ]);
    expect(answers.map((a) => a.status)).toEqual([200, 204]);
    expect(await adaRole()).toBe("member");
  }, 60_000);
});
