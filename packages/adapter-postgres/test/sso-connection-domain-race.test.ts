import { createAuth, type MailMessage, type StorageAdapter } from "@authtempo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// A domain write beside a connection write, on the real Postgres adapter
// (ruling 34 of plan 12d). An enforced domain must route to an enabled
// connection, else its staff cannot sign in. The domain update locks the
// connection row before its check. The connection update writes its row
// before its check of the enforced domains. The connection delete deletes
// its row before the domain update. The organization delete deletes the
// connection rows before the domain rows (ruling 35). So the four take the
// connection row first, and then the domain rows. Each state comes from the
// api: the magic link, the organization api, and the SSO api with a fake
// resolver.

const API = "https://api.example.com";
const APP = { kind: "app", name: "race-test" } as const;
/** Every request passes: the race, not the limit, is under test. */
const OPEN = { allow: async () => true };
/** The pause of the first writer after its first step on the connection row. */
const HOLD_MS = 600;

let db: Awaited<ReturnType<typeof freshDatabase>>;
beforeEach(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await db.close();
});

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function must<T>(r: { ok: true; value: T } | { ok: false; code: string } | undefined): T {
  if (!r) throw new Error("no answer");
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

/**
 * The engine on Postgres with OIDC connections on. `hold` runs once, after
 * the first read or write of a connection row in a transaction, while that
 * transaction is open. The resolver answers each TXT record in `records`.
 */
function world() {
  const sent: MailMessage[] = [];
  const records: Record<string, string[]> = {};
  const probe: { hold: (() => Promise<void>) | null } = { hold: null };
  const adapter = createPostgresAdapter(db.sql);
  const after = async (model: string) => {
    const run = model === "ssoConnection" ? probe.hold : null;
    if (run) {
      probe.hold = null;
      await run();
    }
  };
  const wrap = (tx: StorageAdapter): StorageAdapter => ({
    ...tx,
    findOne: (async (model: never, where: never) => {
      const row = await tx.findOne(model, where);
      await after(model);
      return row;
    }) as typeof tx.findOne,
    update: (async (model: never, where: never, data: never) => {
      const n = await tx.update(model, where, data);
      await after(model);
      return n;
    }) as typeof tx.update,
    delete: (async (model: never, where: never) => {
      const n = await tx.delete(model, where);
      await after(model);
      return n;
    }) as typeof tx.delete,
  });
  const storage: StorageAdapter = {
    ...adapter,
    transaction: ((fn: (tx: StorageAdapter) => Promise<unknown>) =>
      adapter.transaction((tx) => fn(wrap(tx)))) as typeof adapter.transaction,
  };
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [],
    storage,
    limiter: OPEN,
    mail: {
      send: async (m) => {
        sent.push(m);
      },
    },
    organizations: {},
    sso: { oidc: true, dns: [{ name: "a", txt: async (name) => records[name] ?? [] }] },
  });
  /** An organization of a verified owner, one OIDC connection, and one verified domain. */
  async function scene() {
    await auth.api.requestMagicLink({ email: "ada@example.com", ip: null });
    const text = sent.at(-1)?.text ?? "";
    const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(text)?.[1] ?? "");
    const signed = await auth.api.verifyMagicLink({ token, ip: null, userAgent: null });
    if (!signed.ok || !("token" in signed.value)) throw new Error("no session");
    const organizationId = must(
      await auth.api.createOrganization({ user: signed.value.user, slug: "acme", name: "Acme" }),
    ).organization.id;
    const sso = auth.api.sso;
    if (!sso) throw new Error("no sso api");
    const connectionId = must(
      await sso.connections.create({
        actor: APP,
        organizationId,
        kind: "oidc",
        label: "Acme IdP",
        issuer: "https://login.idp.example/acme",
        clientId: "acme-client",
        clientSecret: "the-client-secret-0123456789",
      }),
    ).id;
    const added = must(
      await sso.domains.add({ actor: APP, organizationId, domain: "acme.example" }),
    );
    if (!added.record) throw new Error("no record");
    records[added.record.name] = [added.record.value];
    must(await sso.domains.verify({ actor: APP, id: added.id }));
    return { sso, user: signed.value.user, organizationId, connectionId, domainId: added.id };
  }
  return { auth, probe, scene };
}

/** The domain rows: the route and the flag. */
async function domains() {
  return db.sql<{ connection: string | null; enforce: boolean }[]>`
    SELECT connection_id AS connection, enforce FROM ta_sso_domain`;
}

/** The organization rows: the id. */
async function organizations() {
  return db.sql<{ id: string }[]>`SELECT id FROM ta_organization`;
}

/** The connection rows: the id and the flag. */
async function connections() {
  return db.sql<{ id: string; enabled: boolean }[]>`SELECT id, enabled FROM ta_sso_connection`;
}

describe("a domain write beside a connection write on Postgres (ruling 34 of plan 12d)", () => {
  it("never leaves a domain enforced on a connection that a parallel delete removed", async () => {
    const w = world();
    const s = await w.scene();
    let deleting: Promise<unknown> | null = null;
    // 1: the domain update holds the connection row. The delete starts and waits on it.
    w.probe.hold = async () => {
      deleting = s.sso.connections.delete({ actor: APP, id: s.connectionId });
      deleting.catch(() => {});
      await pause(HOLD_MS);
    };
    const routed = await s.sso.domains.update({
      actor: APP,
      id: s.domainId,
      connectionId: s.connectionId,
      enforce: true,
    });
    expect(routed).toMatchObject({ ok: true });
    expect(await deleting).toMatchObject({ ok: true });
    expect(await connections()).toEqual([]);
    // The delete ran after the commit of the route, so it took the route and the flag off.
    expect(await domains()).toEqual([{ connection: null, enforce: false }]);
  }, 60_000);

  it("refuses to disable a connection that a parallel update enforces on", async () => {
    const w = world();
    const s = await w.scene();
    must(await s.sso.domains.update({ actor: APP, id: s.domainId, connectionId: s.connectionId }));
    let disabling: Promise<unknown> | null = null;
    // 1: the domain update holds the connection row. The disable starts and waits on it.
    w.probe.hold = async () => {
      disabling = s.sso.connections.update({ actor: APP, id: s.connectionId, enabled: false });
      disabling.catch(() => {});
      await pause(HOLD_MS);
    };
    expect(await s.sso.domains.update({ actor: APP, id: s.domainId, enforce: true })).toMatchObject(
      { ok: true },
    );
    // The disable reads the enforced domain after its row write, and the throw undoes the write.
    expect(await disabling).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await connections()).toEqual([{ id: s.connectionId, enabled: true }]);
    expect(await domains()).toEqual([{ connection: s.connectionId, enforce: true }]);
  }, 60_000);

  it("refuses to enforce on a connection that a parallel update disables", async () => {
    const w = world();
    const s = await w.scene();
    must(await s.sso.domains.update({ actor: APP, id: s.domainId, connectionId: s.connectionId }));
    let enforcing: Promise<unknown> | null = null;
    // 1: the disable holds the connection row after its write. The enforce starts and waits on it.
    w.probe.hold = async () => {
      enforcing = s.sso.domains.update({ actor: APP, id: s.domainId, enforce: true });
      enforcing.catch(() => {});
      await pause(HOLD_MS);
    };
    expect(
      await s.sso.connections.update({ actor: APP, id: s.connectionId, enabled: false }),
    ).toMatchObject({ ok: true });
    // The enforce reads the connection after its lock, and sees the committed disable.
    expect(await enforcing).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await connections()).toEqual([{ id: s.connectionId, enabled: false }]);
    expect(await domains()).toEqual([{ connection: s.connectionId, enforce: false }]);
  }, 60_000);
});

describe("a domain update beside an organization delete on Postgres (ruling 35 of plan 12d)", () => {
  it("deletes the organization after a domain update that holds the connection row", async () => {
    const w = world();
    const s = await w.scene();
    let deleting: Promise<unknown> | null = null;
    // 1: the domain update holds the connection row. The delete starts and waits on it.
    w.probe.hold = async () => {
      deleting = w.auth.api.deleteOrganization({ user: s.user, organizationId: s.organizationId });
      deleting.catch(() => {});
      await pause(HOLD_MS);
    };
    const routed = await s.sso.domains.update({
      actor: APP,
      id: s.domainId,
      connectionId: s.connectionId,
      enforce: true,
    });
    expect(routed).toMatchObject({ ok: true });
    // The delete takes the connection row before the domain rows, so it waits and no deadlock occurs.
    expect(await deleting).toMatchObject({ ok: true });
    expect(await organizations()).toEqual([]);
    expect(await connections()).toEqual([]);
    expect(await domains()).toEqual([]);
  }, 60_000);

  it("refuses a domain update that waits on an organization delete", async () => {
    const w = world();
    const s = await w.scene();
    let routing: Promise<unknown> | null = null;
    // 1: the organization delete holds the connection row after its delete. The update starts.
    w.probe.hold = async () => {
      routing = s.sso.domains.update({
        actor: APP,
        id: s.domainId,
        connectionId: s.connectionId,
        enforce: true,
      });
      routing.catch(() => {});
      await pause(HOLD_MS);
    };
    expect(
      await w.auth.api.deleteOrganization({ user: s.user, organizationId: s.organizationId }),
    ).toMatchObject({ ok: true });
    // The update locks the connection row after the commit of the delete, and finds no row.
    expect(await routing).toMatchObject({ ok: false, code: "not_found" });
    expect(await organizations()).toEqual([]);
    expect(await connections()).toEqual([]);
    expect(await domains()).toEqual([]);
  }, 60_000);
});
