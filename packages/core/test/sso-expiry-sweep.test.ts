import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, SsoConfig } from "../src/config.js";
import { createScimToken } from "../src/engine/scim/tokens.js";
import { createSetupLink, revokeSetupLink } from "../src/engine/sso/setup-links.js";
import { sweepExpired } from "../src/engine/sweep.js";
import type { AuthEvent } from "../src/observe/port.js";
import { newId } from "../src/primitives/ids.js";
import type { ExpiryKind } from "../src/schema.js";
import type { StorageAdapter } from "../src/storage/port.js";
import { createTestIdp } from "../src/testing/saml-idp.js";
import { recordCredential } from "./helpers.js";
import { SCIM_APP, scimAuth } from "./scim/helpers.js";
import { SSO_APP, seedOrganization, verifiedDomain } from "./sso/helpers.js";
import { samlConnection } from "./sso/saml-helpers.js";

/**
 * The expiry step of the sweep (plan 13b Task 10, spec 6.7 item 2). The sweep claims each due
 * stage of a SAML certificate, a SCIM token, or a setup link with one conditional update. Then
 * it sends the notice to the owners, emits `sso.expiring`, and runs `hooks.sso.expiring`.
 */

const DAY_MS = 86_400_000;
/** The end of the certificate of each SAML row: its stage 30 is due on 2027-01-16. */
const END = new Date("2027-02-15T00:00:00.000Z");
const STAGE_30 = "2027-01-16T00:00:00.000Z";
const LOG_METHODS = ["error", "info", "warn", "log", "debug"] as const;

beforeEach(() => {
  for (const m of LOG_METHODS) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

interface Expiring {
  organizationId: string;
  kind: ExpiryKind;
  id: string;
  at: Date;
}

/**
 * The world of `scimAuth` (acme, one owner) with SAML, the setup links, a sink of the events,
 * and a hook that records each call. `hook` runs after the record. `overrides` replaces a top key.
 */
async function world(overrides: Partial<AuthConfig> = {}, hook?: () => unknown) {
  const batches: AuthEvent[][] = [];
  const calls: Expiring[] = [];
  const w = await scimAuth({
    sso: { saml: true, setup: {} } as SsoConfig,
    observe: { sink: { write: (b) => void batches.push([...b]) } },
    hooks: {
      sso: {
        async expiring(e) {
          calls.push(e);
          if (hook) await hook();
        },
      },
    },
    ...overrides,
  });
  const events = async (name: string) => {
    await w.config.observe.flush();
    return batches.flat().filter((e) => e.name === name);
  };
  return { ...w, calls, events };
}
type W = Awaited<ReturnType<typeof world>>;

/** Moves the clock of the world to the time `iso`. */
function moveTo(w: W, iso: string) {
  w.clock.advance(new Date(iso).getTime() - w.clock.now().getTime());
}

/** One SAML connection of `org` whose certificate ends at `END`. Its id. */
async function samlRow(w: W, org = w.org, entityId = "https://idp.example/metadata") {
  const idp = await createTestIdp({ alg: "rsa", certificateNotAfter: END, entityId });
  return samlConnection(w, org, idp);
}

/** `n` more owners of `org`: the member rows that `addMember` writes, one second apart. */
async function moreOwners(w: W, n: number, org = w.org, slug = "acme") {
  for (let i = 2; i < n + 2; i++) {
    const user = await w.seedUser(`owner${i}@${slug}.example`);
    w.clock.advance(1000);
    const now = w.clock.now();
    await w.storage.create("member", {
      id: newId(now),
      createdAt: now,
      updatedAt: now,
      organizationId: org,
      userId: user.id,
      role: "owner",
    });
  }
}

const connection = async (w: W, id: string) => {
  const row = await w.storage.findOne("ssoConnection", [{ field: "id", op: "eq", value: id }]);
  if (!row) throw new Error("no connection");
  return row;
};

/** The stage and the next notice of a row, as the sweep left them. */
const stageOf = (row: { expiryStage: number | null; expiryNoticeAt: Date | null }) => [
  row.expiryStage,
  row.expiryNoticeAt?.toISOString() ?? null,
];

/** The mails that `run` sends. */
async function mailsOf(w: W, run: () => Promise<unknown>) {
  const before = w.mail.length;
  await run();
  return w.mail.slice(before);
}

describe("the expiry step of the sweep (plan 13b Task 10)", () => {
  it("stage 30: one mail per owner, stage 30, the next notice on 2027-02-08, and one hook call", async () => {
    const w = await world();
    await moreOwners(w, 1);
    const id = await samlRow(w);
    expect((await connection(w, id)).expiryNoticeAt?.toISOString()).toBe(STAGE_30);
    moveTo(w, STAGE_30);
    let notices = 0;
    const mails = await mailsOf(w, async () => {
      notices = (await sweepExpired(w.config)).ssoExpiryNotices;
    });
    expect(notices).toBe(1);
    expect(mails.map((m) => m.to).sort()).toEqual(["owner2@acme.example", "owner@acme.example"]);
    expect(stageOf(await connection(w, id))).toEqual([30, "2027-02-08T00:00:00.000Z"]);
    expect(w.calls).toEqual([{ organizationId: w.org, kind: "saml_certificate", id, at: END }]);
    // The info fields, and the fields of each line. No address and no token.
    expect(await w.events("sso.expiring")).toEqual([
      {
        name: "sso.expiring",
        level: "info",
        at: STAGE_30,
        traceId: expect.any(String),
        spanId: expect.any(String),
        kind: "saml_certificate",
        rowId: id,
        organizationId: w.org,
        stage: 30,
        mails: 2,
        ownersCut: 0,
      },
    ]);
    // The text names the kind, the label, the date, and the days. A certificate keeps signing in.
    const text = mails[0]?.text ?? "";
    expect(text).toContain("SAML certificate");
    expect(text).toContain("SAML IdP");
    expect(text).toContain(END.toISOString());
    expect(text).toContain("30 days");
    expect(text).toContain("Sign-ins go on");
  });

  it("race: two sweeps at once claim the stage once, and the hook runs once", async () => {
    const w = await world();
    const id = await samlRow(w);
    moveTo(w, STAGE_30);
    // The second sweep runs whole between the read and the claim of the first one.
    let inner: Promise<unknown> | null = null;
    const racing = new Proxy(w.config.storage, {
      get(target, key) {
        if (key === "update")
          return async (...args: Parameters<StorageAdapter["update"]>) => {
            const [model, , changes] = args;
            if (model === "ssoConnection" && "expiryStage" in changes && inner === null) {
              inner = sweepExpired(w.config);
              await inner;
            }
            return target.update(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const mails = await mailsOf(w, () => sweepExpired({ ...w.config, storage: racing }));
    expect(inner).not.toBeNull();
    expect(w.calls).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect(await w.events("sso.expiring")).toHaveLength(1);
    expect(stageOf(await connection(w, id))).toEqual([30, "2027-02-08T00:00:00.000Z"]);
  });

  it("skip: a sweep that comes late sends one notice, of the nearest stage, and none after it", async () => {
    const w = await world();
    const id = await samlRow(w);
    moveTo(w, "2027-02-14T12:00:00.000Z");
    const mails = await mailsOf(w, async () => {
      expect((await sweepExpired(w.config)).ssoExpiryNotices).toBe(1);
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]?.text).toContain("1 day");
    expect(stageOf(await connection(w, id))).toEqual([1, null]);
    expect((await w.events("sso.expiring")).map((e) => (e as { stage?: number }).stage)).toEqual([
      1,
    ]);
    expect((await sweepExpired(w.config)).ssoExpiryNotices).toBe(0);
    expect(w.calls).toHaveLength(1);
  });

  it("notices off: no mail, and the event and the hook still run", async () => {
    const w = await world({ account: { notices: false }, sso: { saml: true } as SsoConfig });
    const id = await samlRow(w);
    moveTo(w, STAGE_30);
    const mails = await mailsOf(w, () => sweepExpired(w.config));
    expect(mails).toEqual([]);
    expect(w.calls.map((c) => c.id)).toEqual([id]);
    expect(await w.events("sso.expiring")).toMatchObject([{ rowId: id, stage: 30, mails: 0 }]);
    expect(stageOf(await connection(w, id))).toEqual([30, "2027-02-08T00:00:00.000Z"]);
  });

  it("mail fails: notice.mail_failed, the stage stays, and the next sweep does not send again", async () => {
    const w = await world();
    const id = await samlRow(w);
    moveTo(w, STAGE_30);
    const sends: string[] = [];
    const failing = {
      ...w.config,
      mail: {
        send: async (m: { to: string }) => {
          sends.push(m.to);
          throw new Error("the mail provider is down");
        },
      },
    };
    expect((await sweepExpired(failing)).ssoExpiryNotices).toBe(1);
    expect(await w.events("notice.mail_failed")).toMatchObject([
      { name: "notice.mail_failed", event: "sso_expiring" },
    ]);
    expect(await w.events("sso.expiring")).toMatchObject([{ rowId: id, mails: 0 }]);
    expect(stageOf(await connection(w, id))).toEqual([30, "2027-02-08T00:00:00.000Z"]);
    // The claim is the record: the next sweep sends nothing.
    expect((await sweepExpired(failing)).ssoExpiryNotices).toBe(0);
    expect(sends).toEqual(["owner@acme.example"]);
    expect(await w.events("notice.mail_failed")).toHaveLength(1);
    expect(w.calls).toHaveLength(1);
  });

  it("hook throws: one log line, and the stage stays", async () => {
    const w = await world({}, () => {
      throw new Error("the hook of the app fails");
    });
    const id = await samlRow(w);
    moveTo(w, STAGE_30);
    expect((await sweepExpired(w.config)).ssoExpiryNotices).toBe(1);
    expect(await w.events("hook.after_failed")).toMatchObject([
      { name: "hook.after_failed", hook: "sso.expiring", rowId: id },
    ]);
    expect(stageOf(await connection(w, id))).toEqual([30, "2027-02-08T00:00:00.000Z"]);
    expect((await sweepExpired(w.config)).ssoExpiryNotices).toBe(0);
    expect(w.calls).toHaveLength(1);
  });

  it("revoked link: a due revoked link gets no mail, and its expiryNoticeAt goes to null", async () => {
    const w = await world();
    const made = await createSetupLink(w.config, SSO_APP, {
      organizationId: w.org,
      steps: ["domain"],
      kinds: ["saml"],
      ttlHours: 168,
      note: "Ada at Acme IT",
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const revoked = await revokeSetupLink(w.config, SSO_APP, made.value.id);
    expect(revoked.ok).toBe(true);
    const link = async () =>
      w.storage.findOne("ssoSetupLink", [{ field: "id", op: "eq", value: made.value.id }]);
    const due = (await link())?.expiryNoticeAt;
    expect(due?.getTime()).toBe(made.value.expiresAt.getTime() - DAY_MS);
    moveTo(w, due?.toISOString() ?? "");
    let notices = -1;
    const mails = await mailsOf(w, async () => {
      notices = (await sweepExpired(w.config)).ssoExpiryNotices;
    });
    expect([notices, mails, w.calls]).toEqual([0, [], []]);
    const row = await link();
    expect(row ? stageOf(row) : null).toEqual([null, null]);
    expect(await w.events("sso.expiring")).toEqual([]);
  });

  it("many owners: 15 owners get 10 mails, and the event counts 5 owners cut", async () => {
    const w = await world();
    await moreOwners(w, 14);
    const id = await samlRow(w);
    moveTo(w, STAGE_30);
    const mails = await mailsOf(w, () => sweepExpired(w.config));
    expect(mails).toHaveLength(10);
    expect(await w.events("sso.expiring")).toMatchObject([{ rowId: id, mails: 10, ownersCut: 5 }]);
  });

  it("budget: 3 kinds with 5 due rows each and 3 owners each fit one sweep of 50 calls, and the rest wait", async () => {
    const w = await world();
    const orgs: { id: string; slug: string }[] = [{ id: w.org, slug: "acme" }];
    for (const slug of ["beta", "gamma", "delta", "omega"]) {
      const id = await seedOrganization(w, slug);
      await verifiedDomain(w, id, `${slug}.example`);
      orgs.push({ id, slug });
    }
    for (const [i, org] of orgs.entries()) {
      // `seedOrganization` gives one owner, and `scimAuth` gives acme its owner.
      await moreOwners(w, 2, org.id, org.slug);
      await samlRow(w, org.id, `https://idp.example/${i}`);
    }
    // At 2027-01-10 each token gets its stage 30 notice date now, and each link of 168 hours
    // its stage 1 date on 2027-01-16, the date of the SAML rows.
    moveTo(w, "2027-01-10T00:00:00.000Z");
    for (const org of orgs) {
      const token = await createScimToken(w.config, SCIM_APP, {
        organizationId: org.id,
        name: `Directory ${org.slug}`,
        expiresInDays: 31,
      });
      if (!token.ok) throw new Error(token.code);
      recordCredential(token.value.token);
      const link = await createSetupLink(w.config, SSO_APP, {
        organizationId: org.id,
        steps: ["domain"],
        kinds: ["saml"],
        ttlHours: 168,
        note: `IT of ${org.slug}`,
      });
      if (!link.ok) throw new Error(link.code);
      recordCredential(link.value.token);
    }
    moveTo(w, STAGE_30);
    const now = w.clock.now();
    const due = async () =>
      (
        await Promise.all(
          (["ssoConnection", "scimToken", "ssoSetupLink"] as const).map((model) =>
            w.storage.findMany(model, [{ field: "expiryNoticeAt", op: "lte", value: now }]),
          ),
        )
      ).flat().length;
    expect(await due()).toBe(15);
    // The calls of one sweep: the storage calls, the mails, and the limiter sweep.
    const sweep = async () => {
      const start = w.storage.statementsSent?.() ?? 0;
      const sent = w.mail.length;
      const result = await sweepExpired(w.config);
      const limiter = w.config.limiter.sweep ? 1 : 0;
      const calls = (w.storage.statementsSent?.() ?? 0) - start + (w.mail.length - sent) + limiter;
      return { calls, notices: result.ssoExpiryNotices };
    };
    const first = await sweep();
    expect(first.calls).toBeLessThanOrEqual(50);
    expect(first.notices).toBeGreaterThan(0);
    expect(await due()).toBe(15 - first.notices);
    expect(first.notices).toBeLessThan(15);
    // The rest wait for the next sweeps, each in the budget.
    const passes = [first];
    while (passes.length < 10 && (passes.at(-1)?.notices ?? 0) > 0) passes.push(await sweep());
    for (const p of passes) expect(p.calls).toBeLessThanOrEqual(50);
    expect(passes.reduce((n, p) => n + p.notices, 0)).toBe(15);
    expect(await due()).toBe(0);
    expect(w.calls).toHaveLength(15);
  });

  it("sso off: no read of ssoConnection, and the SCIM tokens still get their notice", async () => {
    const w = await world();
    await samlRow(w);
    // A token of 45 days from 2027-01-01 ends with the certificate: its stage 30 is due with it.
    moveTo(w, "2027-01-01T00:00:00.000Z");
    const token = await createScimToken(w.config, SCIM_APP, {
      organizationId: w.org,
      name: "Directory",
      expiresInDays: 45,
    });
    if (!token.ok) throw new Error(token.code);
    recordCredential(token.value.token);
    moveTo(w, STAGE_30);
    const reads = vi.spyOn(w.config.storage, "findMany");
    const result = await sweepExpired({ ...w.config, sso: null });
    expect(reads.mock.calls.filter(([model]) => model === "ssoConnection")).toEqual([]);
    expect(reads.mock.calls.filter(([model]) => model === "ssoSetupLink")).toEqual([]);
    expect(result.ssoExpiryNotices).toBe(1);
    expect(w.calls).toMatchObject([{ kind: "scim_token", id: token.value.id }]);
  });

  it("names the token and the link in the notice, with no token, and stops one kind on a storage fault", async () => {
    const w = await world();
    await samlRow(w);
    moveTo(w, "2027-01-01T00:00:00.000Z");
    const token = await createScimToken(w.config, SCIM_APP, {
      organizationId: w.org,
      name: "Okta directory",
      expiresInDays: 45,
    });
    if (!token.ok) throw new Error(token.code);
    recordCredential(token.value.token);
    moveTo(w, "2027-01-10T00:00:00.000Z");
    const link = await createSetupLink(w.config, SSO_APP, {
      organizationId: w.org,
      steps: ["domain"],
      kinds: ["saml"],
      ttlHours: 168,
      note: "Ada at Acme IT",
    });
    if (!link.ok) throw new Error(link.code);
    recordCredential(link.value.token);
    moveTo(w, STAGE_30);
    // The read of the due SAML rows throws: that kind stops, and the other two go on.
    const faulty = new Proxy(w.config.storage, {
      get(target, key) {
        if (key === "findMany")
          return (...args: Parameters<StorageAdapter["findMany"]>) => {
            if (args[0] === "ssoConnection") throw new Error("D1_ERROR: too many queries");
            return target.findMany(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const mails = await mailsOf(w, async () => {
      expect((await sweepExpired({ ...w.config, storage: faulty })).ssoExpiryNotices).toBe(2);
    });
    expect(await w.events("sweep.sso_expiry_stopped")).toHaveLength(1);
    expect(w.calls.map((c) => c.kind)).toEqual(["scim_token", "setup_link"]);
    const [tokenMail, linkMail] = mails.map((m) => m.text);
    expect(tokenMail).toContain("SCIM token");
    expect(tokenMail).toContain("Okta directory");
    expect(linkMail).toContain("setup link");
    expect(linkMail).toContain("Ada at Acme IT");
    for (const text of [tokenMail, linkMail]) {
      expect(text).not.toContain(token.value.token);
      expect(text).not.toContain(link.value.token);
    }
  });
});
