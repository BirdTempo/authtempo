import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, resolveConfig } from "../../src/config.js";
import { deleteOrganization } from "../../src/engine/organizations.js";
import {
  addDomain,
  claimingDomain,
  inOrganizationDomains,
  listDomains,
  normalizeDomain,
  recheckDomains,
  updateDomain,
  verifyDomain,
} from "../../src/engine/sso/domains.js";
import { sweepExpired } from "../../src/engine/sweep.js";
import { sha256Hex } from "../../src/primitives/crypto.js";
import type { OperatorAuditRow } from "../../src/schema.js";
import { createMemoryAdapter } from "../../src/storage/memory.js";
import { meterOf } from "../../src/storage/meter.js";
import type { StorageAdapter } from "../../src/storage/port.js";
import { BASE_URL } from "../helpers.js";
import { fakeDns, SSO_APP, seedOrganization, ssoAuth } from "./helpers.js";

beforeEach(() => {
  // A refused proof and a lost domain write one log line each; the tests read the answers.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type SsoWorld = ReturnType<typeof ssoAuth>;

/** The audit rows of one action, oldest first. */
async function auditOf(w: SsoWorld, action: OperatorAuditRow["action"]) {
  return w.storage.findMany("operatorAudit", [{ field: "action", op: "eq", value: action }], {
    sort: { field: "id", dir: "asc" },
  });
}

/** A domain added by the app: its id and its record. Each step must answer ok. */
async function added(w: SsoWorld, organizationId: string, domain = "acme.example") {
  const r = await addDomain(w.config, SSO_APP, { organizationId, domain });
  if (!r.ok) throw new Error(r.code);
  if (r.value.record === null) throw new Error("no record");
  return { id: r.value.id, record: r.value.record };
}

/** Both resolvers give the value of `record`. */
function publish(w: SsoWorld, record: { name: string; value: string }) {
  w.answers.a[record.name] = [record.value];
  w.answers.b[record.name] = [record.value];
}

/** A domain verified through both resolvers, the only way to a claim. */
async function verified(w: SsoWorld, organizationId: string, domain = "acme.example") {
  const d = await added(w, organizationId, domain);
  publish(w, d.record);
  const r = await verifyDomain(w.config, SSO_APP, { id: d.id });
  if (!r.ok) throw new Error(r.code);
  return d;
}

describe("the SSO domains", () => {
  it("normalizes a domain to its A-label form", () => {
    expect(normalizeDomain("Bücher.Example")).toBe("xn--bcher-kva.example");
    expect(normalizeDomain("ACME.Example")).toBe("acme.example");
    expect(normalizeDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    expect(normalizeDomain("mail.eu.acme.example")).toBe("mail.eu.acme.example");
    const refused: unknown[] = [
      "1.2.3.4",
      "localhost",
      "a.example.",
      "*.a.example",
      "a b.example",
      // The characters of a URL part, and a control character.
      "a/b.example",
      "a:1.example",
      "u@a.example",
      "a\tb.example",
      // The URL parser maps these to another host: an IPv4 form, a percent escape, a full-width letter, an ideographic dot.
      "0x7f.1",
      "a%2eb.example",
      "ｅxample.com",
      "a。example",
      // An ideographic dot after an A-label: one given label, two mapped labels.
      "xn--bcher-kva。example",
      // The URL parser reads a last label of digits as an IPv4 part, and throws.
      "example.123",
      // A label that no host name holds.
      "a_b.example",
      "-a.example",
      "a..example",
      `${"a".repeat(64)}.example`,
      "[::1]",
      "",
      ` acme.example`,
      `${"a.".repeat(126)}ab`,
      // 231 characters in Unicode, 255 in A-labels.
      `${`${"ü".repeat(55)}.`.repeat(4)}example`,
      7,
      null,
    ];
    for (const raw of refused) expect(normalizeDomain(raw), JSON.stringify(raw)).toBeNull();
  });

  it("gives the record to publish once per pending row", async () => {
    const w = ssoAuth();
    const org = await seedOrganization(w);
    const first = await addDomain(w.config, SSO_APP, {
      organizationId: org,
      domain: "ACME.example",
    });
    if (!first.ok) throw new Error(first.code);
    expect(first.value).toMatchObject({
      domain: "acme.example",
      verified: false,
      verifiedAt: null,
      enforce: false,
      expiresAt: new Date(w.clock.now().getTime() + 7 * DAY_MS).toISOString(),
    });
    expect(first.value.record?.name).toBe("_authtempo-challenge.acme.example");
    expect(first.value.record?.type).toBe("TXT");
    expect(first.value.record?.value).toMatch(/^authtempo-domain=[A-Za-z0-9_-]{43}$/);
    // A retry of the same domain: the same row with a new challenge.
    const second = await addDomain(w.config, SSO_APP, {
      organizationId: org,
      domain: "acme.example",
    });
    if (!second.ok) throw new Error(second.code);
    expect(second.value.id).toBe(first.value.id);
    expect(second.value.record?.value).not.toBe(first.value.record?.value);
    const rows = await auditOf(w, "sso_domain_add");
    expect(rows.map((r) => [r.actorKind, r.actorId, r.data])).toEqual([
      [
        "app",
        "sso-test",
        { organizationId: org, domainId: first.value.id, domain: "acme.example" },
      ],
      [
        "app",
        "sso-test",
        { organizationId: org, domainId: first.value.id, domain: "acme.example" },
      ],
    ]);
    // The row's challenge is in no audit row and no log line.
    expect(JSON.stringify(rows)).not.toContain(second.value.record?.value.slice(17));
  });

  it("refuses a domain whose proof name passes the DNS limit of 253 characters", async () => {
    const w = ssoAuth();
    const org = await seedOrganization(w);
    // 192 characters of three full labels, then 36 or 37 more and ".com": 232 or 233 in all.
    const labels = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.`;
    const fits = `${labels}${"d".repeat(36)}.com`;
    const over = `${labels}${"d".repeat(37)}.com`;
    expect([fits.length, over.length]).toEqual([232, 233]);
    // Each is a domain: only the proof name `_authtempo-challenge.<domain>` passes the limit.
    expect(normalizeDomain(over)).toBe(over);
    const ok = await addDomain(w.config, SSO_APP, { organizationId: org, domain: fits });
    expect(ok.ok && ok.value.record?.name.length).toBe(253);
    expect(await addDomain(w.config, SSO_APP, { organizationId: org, domain: over })).toMatchObject(
      { ok: false, code: "invalid_body" },
    );
  });

  it("refuses a proof that one resolver does not give", async () => {
    const w = ssoAuth();
    const org = await seedOrganization(w);
    const d = await added(w, org);
    w.answers.a[d.record.name] = [d.record.value];
    w.answers.b[d.record.name] = ["authtempo-domain=another"];
    expect(await verifyDomain(w.config, SSO_APP, { id: d.id })).toMatchObject({
      ok: false,
      code: "domain_unverified",
      status: 400,
    });
    // Then b never answers: the deadline of 10 seconds ends the wait.
    w.b.txt = () => new Promise<never>(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = verifyDomain(w.config, SSO_APP, { id: d.id });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ ok: false, code: "domain_unverified" });
    const row = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: d.id }]);
    expect([row?.claimedDomain, row?.verifiedAt]).toEqual([null, null]);
    expect(await auditOf(w, "sso_domain_verify")).toEqual([]);
  });

  it("verifies when every resolver gives the value", async () => {
    const w = ssoAuth();
    const org = await seedOrganization(w);
    const d = await added(w, org);
    // A TXT record set may hold other strings beside the value.
    w.answers.a[d.record.name] = ["v=spf1 -all", d.record.value];
    w.answers.b[d.record.name] = [d.record.value];
    const r = await verifyDomain(w.config, SSO_APP, { id: d.id });
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({
      verified: true,
      record: null,
      verifiedAt: w.clock.now().toISOString(),
      checkedAt: w.clock.now().toISOString(),
      expiresAt: null,
    });
    expect(w.a.calls).toEqual([d.record.name]);
    expect(w.b.calls).toEqual([d.record.name]);
    const rows = await auditOf(w, "sso_domain_verify");
    expect(rows.map((x) => [x.actorKind, x.actorId, x.targetUserId, x.data])).toEqual([
      ["app", "sso-test", null, { organizationId: org, domainId: d.id, domain: "acme.example" }],
    ]);
    expect(rows[0]?.reason).toBe("an organization proved a domain by DNS");
  });

  it("gives a domain to one organization in a race", async () => {
    const w = ssoAuth();
    const one = await added(w, await seedOrganization(w, "one"));
    const two = await added(w, await seedOrganization(w, "two"));
    // Each organization published its own value; both resolvers give both.
    const both = [one.record.value, two.record.value];
    w.answers.a[one.record.name] = both;
    w.answers.b[one.record.name] = both;
    const answers = await Promise.all([
      verifyDomain(w.config, SSO_APP, { id: one.id }),
      verifyDomain(w.config, SSO_APP, { id: two.id }),
    ]);
    expect(answers.map((r) => (r.ok ? "ok" : r.code)).sort()).toEqual(["domain_taken", "ok"]);
    const claimed = await w.storage.findMany("ssoDomain", [
      { field: "claimedDomain", op: "eq", value: "acme.example" },
    ]);
    expect(claimed).toHaveLength(1);
    expect(await auditOf(w, "sso_domain_verify")).toHaveLength(1);
    // Two verifies of one row at once: one claim and one audit row.
    const three = await added(w, await seedOrganization(w, "three"), "three.example");
    publish(w, three.record);
    const same = await Promise.all([
      verifyDomain(w.config, SSO_APP, { id: three.id }),
      verifyDomain(w.config, SSO_APP, { id: three.id }),
    ]);
    expect(same.map((r) => r.ok && r.value.verified)).toEqual([true, true]);
    expect(await auditOf(w, "sso_domain_verify")).toHaveLength(2);
  });

  it("refuses enforce on a domain with no routed connection", async () => {
    const w = ssoAuth();
    const d = await verified(w, await seedOrganization(w));
    expect(await updateDomain(w.config, SSO_APP, { id: d.id, enforce: true })).toEqual({
      ok: false,
      code: "invalid_body",
      status: 400,
      message: "enforce needs a verified domain routed to an enabled connection",
    });
    const row = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: d.id }]);
    expect(row?.enforce).toBe(false);
    expect(await auditOf(w, "sso_domain_update")).toEqual([]);
    // The other flags change, with one audit row that names the changed keys.
    const r = await updateDomain(w.config, SSO_APP, { id: d.id, includeSubdomains: true });
    expect(r.ok && r.value.includeSubdomains).toBe(true);
    expect((await auditOf(w, "sso_domain_update")).map((x) => x.data?.changed)).toEqual([
      ["includeSubdomains"],
    ]);
  });

  it("loses a domain after three failures that span 72 hours", async () => {
    /** Verify, move 31 days, make both resolvers fail, then sweep at each step of hours. */
    async function failingSweeps(hours: number[]) {
      const w = ssoAuth();
      const d = await verified(w, await seedOrganization(w));
      w.clock.advance(31 * DAY_MS);
      w.answers.a[d.record.name] = [];
      w.answers.b[d.record.name] = [];
      const counts: number[] = [];
      for (const h of hours) {
        w.clock.advance(h * HOUR_MS);
        counts.push((await sweepExpired(w.config)).ssoDomains);
      }
      const row = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: d.id }]);
      return { w, counts, row };
    }
    // Three failures at 0, 36, and 72 hours: the third loses the domain.
    const lost = await failingSweeps([0, 36, 36]);
    expect(lost.counts).toEqual([1, 1, 1]);
    expect(lost.row).toMatchObject({
      verifiedAt: null,
      claimedDomain: null,
      enforce: false,
      failures: 0,
    });
    const rows = await auditOf(lost.w, "sso_domain_lost");
    expect(rows.map((r) => [r.actorKind, r.actorId, r.data?.domain])).toEqual([
      ["app", "authtempo-sweep", "acme.example"],
    ]);
    // A lost domain is checked no more.
    lost.w.clock.advance(31 * DAY_MS);
    expect((await sweepExpired(lost.w.config)).ssoDomains).toBe(0);
    // The same three failures within 48 hours keep the claim.
    const kept = await failingSweeps([0, 24, 24]);
    expect(kept.counts).toEqual([1, 1, 1]);
    expect(kept.row).toMatchObject({ claimedDomain: "acme.example", failures: 3 });
    expect(await auditOf(kept.w, "sso_domain_lost")).toEqual([]);
  });

  it("keeps the claim through failures within 71 hours, and loses it past 72 hours", async () => {
    const w = ssoAuth();
    const d = await verified(w, await seedOrganization(w));
    w.clock.advance(31 * DAY_MS);
    w.answers.a[d.record.name] = [];
    w.answers.b[d.record.name] = [];
    const claimAfter = async (hours: number) => {
      w.clock.advance(hours * HOUR_MS);
      const swept = (await sweepExpired(w.config)).ssoDomains;
      const row = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: d.id }]);
      return [swept, row?.failures, row?.claimedDomain ?? null];
    };
    // Failures at 0, 36, and 71 hours: three failures that span less than 72 hours.
    expect(await claimAfter(0)).toEqual([1, 1, "acme.example"]);
    expect(await claimAfter(36)).toEqual([1, 2, "acme.example"]);
    expect(await claimAfter(35)).toEqual([1, 3, "acme.example"]);
    // The next try is one day later, at 95 hours: the fourth failure is past 72 hours.
    expect(await claimAfter(23)).toEqual([0, 3, "acme.example"]);
    expect(await claimAfter(1)).toEqual([1, 0, null]);
    expect(await auditOf(w, "sso_domain_lost")).toHaveLength(1);
  });

  it("makes a lost domain a pending row that its old record cannot prove", async () => {
    const w = ssoAuth();
    const org = await seedOrganization(w);
    const d = await verified(w, org);
    w.clock.advance(31 * DAY_MS);
    // The resolvers lose the record three times over 72 hours.
    w.answers.a[d.record.name] = [];
    for (const hours of [0, 36, 36]) {
      w.clock.advance(hours * HOUR_MS);
      await sweepExpired(w.config);
    }
    const lostAt = w.clock.now();
    const listed = await listDomains(w.config, SSO_APP, { organizationId: org });
    if (!listed.ok) throw new Error(listed.code);
    const pending = listed.value[0];
    // A pending row of 7 days, with a new record to publish.
    expect(pending).toMatchObject({
      id: d.id,
      verified: false,
      expiresAt: new Date(lostAt.getTime() + 7 * DAY_MS).toISOString(),
    });
    expect(pending?.record?.name).toBe(d.record.name);
    expect(pending?.record?.value).not.toBe(d.record.value);
    // The old record comes back on both resolvers: it proves nothing now.
    publish(w, d.record);
    expect(await verifyDomain(w.config, SSO_APP, { id: d.id })).toMatchObject({
      ok: false,
      code: "domain_unverified",
    });
    // The new record proves the domain again, within the 7 days.
    if (!pending?.record) throw new Error("no record");
    publish(w, pending.record);
    const again = await verifyDomain(w.config, SSO_APP, { id: d.id });
    expect(again.ok && again.value.verified).toBe(true);
  });

  it("deletes a lost domain that no one proves again within 7 days", async () => {
    const w = ssoAuth();
    const org = await seedOrganization(w);
    const d = await verified(w, org);
    w.clock.advance(31 * DAY_MS);
    w.answers.a[d.record.name] = [];
    for (const hours of [0, 36, 36]) {
      w.clock.advance(hours * HOUR_MS);
      await sweepExpired(w.config);
    }
    expect(await auditOf(w, "sso_domain_lost")).toHaveLength(1);
    w.clock.advance(7 * DAY_MS);
    expect((await sweepExpired(w.config)).ssoPendingDomains).toBe(0);
    w.clock.advance(1);
    expect((await sweepExpired(w.config)).ssoPendingDomains).toBe(1);
    expect(
      await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: d.id }]),
    ).toBeNull();
  });

  it("fails a proof and a recheck when a resolver throws", async () => {
    const w = ssoAuth();
    const org = await seedOrganization(w);
    const d = await added(w, org);
    w.answers.a[d.record.name] = [d.record.value];
    w.answers.b[d.record.name] = "throw";
    expect(await verifyDomain(w.config, SSO_APP, { id: d.id })).toMatchObject({
      ok: false,
      code: "domain_unverified",
      status: 400,
    });
    // b gives the value again: the proof passes. Then b throws at the recheck.
    w.answers.b[d.record.name] = [d.record.value];
    const r = await verifyDomain(w.config, SSO_APP, { id: d.id });
    expect(r.ok && r.value.verified).toBe(true);
    w.answers.b[d.record.name] = "throw";
    w.clock.advance(31 * DAY_MS);
    expect((await sweepExpired(w.config)).ssoDomains).toBe(1);
    const row = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: d.id }]);
    expect(row).toMatchObject({
      claimedDomain: "acme.example",
      failures: 1,
      firstFailureAt: w.clock.now(),
    });
  });

  it("rechecks a domain with a retry due before a first recheck", async () => {
    const w = ssoAuth();
    const first = await verified(w, await seedOrganization(w, "first"), "first.example");
    w.clock.advance(DAY_MS);
    const second = await verified(w, await seedOrganization(w, "second"), "second.example");
    w.clock.advance(31 * DAY_MS);
    /** A recheck with calls for one row only: the read, two resolvers, and the writes of a loss. */
    const oneRow = () =>
      recheckDomains(w.config, w.clock.now(), { meter: meterOf(w.storage, 0), limit: 6 });
    // Both are due; the oldest check comes first, and it fails.
    w.answers.a[first.record.name] = [];
    expect(await oneRow()).toBe(1);
    const row = (id: string) =>
      w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: id }]);
    expect((await row(first.id))?.failures).toBe(1);
    // One day later its retry is due. Its check time is now later than the
    // check time of the second domain, and the retry still comes first.
    w.clock.advance(DAY_MS);
    const secondBefore = await row(second.id);
    expect(await oneRow()).toBe(1);
    expect((await row(first.id))?.failures).toBe(2);
    expect(await row(second.id)).toEqual(secondBefore);
  });

  it("answers a retry of an add as the row is when a verify claims it first", async () => {
    const w = ssoAuth();
    const org = await seedOrganization(w);
    const d = await added(w, org);
    publish(w, d.record);
    // A parallel verify commits between the read of the retry and its update.
    // That can occur on Postgres, because the read does not lock the domain row.
    const storage = w.config.storage;
    const transaction = storage.transaction.bind(storage);
    let armed = true;
    vi.spyOn(storage, "transaction").mockImplementation((fn) =>
      transaction((tx) => {
        const view: StorageAdapter = Object.create(tx);
        view.findOne = (async (model, where) => {
          const found = await tx.findOne(model, where);
          if (model === "ssoDomain" && armed && found) {
            armed = false;
            await tx.update("ssoDomain", [{ field: "id", op: "eq", value: d.id }], {
              claimedDomain: "acme.example",
              verifiedAt: w.clock.now(),
              checkedAt: w.clock.now(),
              expiresAt: null,
            });
          }
          return found;
        }) as StorageAdapter["findOne"];
        return fn(view);
      }),
    );
    const before = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: d.id }]);
    const r = await addDomain(w.config, SSO_APP, { organizationId: org, domain: "acme.example" });
    expect(armed).toBe(false);
    // The answer is the claimed row: no record, no new challenge, no audit row of a retry.
    expect(r).toMatchObject({ ok: true, value: { verified: true, record: null, expiresAt: null } });
    const after = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: d.id }]);
    expect(after?.challenge).toBe(before?.challenge);
    expect(await auditOf(w, "sso_domain_add")).toHaveLength(1);
  });

  it("checks a verified domain again after 30 days, and a pass clears the failures", async () => {
    const w = ssoAuth();
    const d = await verified(w, await seedOrganization(w));
    // Not due before 30 days.
    w.clock.advance(29 * DAY_MS);
    expect((await sweepExpired(w.config)).ssoDomains).toBe(0);
    w.clock.advance(2 * DAY_MS);
    w.answers.b[d.record.name] = null;
    expect((await sweepExpired(w.config)).ssoDomains).toBe(1);
    w.answers.b[d.record.name] = [d.record.value];
    w.clock.advance(DAY_MS);
    expect((await sweepExpired(w.config)).ssoDomains).toBe(1);
    const row = await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: d.id }]);
    expect(row).toMatchObject({ failures: 0, firstFailureAt: null, checkedAt: w.clock.now() });
  });

  it("deletes a pending domain past its expiry, and a late verify answers token_expired", async () => {
    const w = ssoAuth();
    const org = await seedOrganization(w);
    const late = await added(w, org);
    const kept = await verified(w, org, "kept.example");
    w.clock.advance(7 * DAY_MS);
    publish(w, late.record);
    expect(await verifyDomain(w.config, SSO_APP, { id: late.id })).toMatchObject({
      ok: false,
      code: "token_expired",
    });
    expect((await sweepExpired(w.config)).ssoPendingDomains).toBe(0);
    w.clock.advance(1);
    expect((await sweepExpired(w.config)).ssoPendingDomains).toBe(1);
    const left = await w.storage.findMany("ssoDomain", [
      { field: "organizationId", op: "eq", value: org },
    ]);
    expect(left.map((r) => r.id)).toEqual([kept.id]);
  });

  it("answers the operator's override only with the sso scope", async () => {
    const SSO_SECRET = "operator-sso-0123456789abcdef-012345678";
    const USERS_SECRET = "operator-users-0123456789abcdef-0123456";
    const w = ssoAuth({
      operator: {
        secrets: [
          { name: "sso", secretHash: await sha256Hex(SSO_SECRET), scopes: ["sso"] },
          { name: "users", secretHash: await sha256Hex(USERS_SECRET), scopes: ["users"] },
        ],
      },
    });
    const org = await seedOrganization(w);
    const pending = await added(w, org, "pending.example");
    const d = await verified(w, org);
    const override = (secret: string, body: unknown) =>
      w.handle(
        new Request(`${BASE_URL}/auth/operator/sso/enforce-off`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Operator ${secret}`,
            "user-agent": "ops/1",
          },
          body: JSON.stringify(body),
        }),
      );
    const refused = await override(USERS_SECRET, { domainId: d.id, reason: "IdP down" });
    expect([refused.status, await refused.json()]).toEqual([403, { error: "operator_required" }]);
    expect(await auditOf(w, "sso_enforce_off")).toEqual([]);
    const lineFeed = await override(SSO_SECRET, { domainId: d.id, reason: "IdP\ndown" });
    expect([lineFeed.status, await lineFeed.json()]).toEqual([400, { error: "invalid_body" }]);
    const res = await override(SSO_SECRET, { domainId: d.id, reason: "IdP down, ticket 7" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enforce: boolean; auditId: string; domain: string };
    expect([body.enforce, body.domain]).toEqual([false, "acme.example"]);
    const rows = await auditOf(w, "sso_enforce_off");
    expect(rows.map((r) => [r.id, r.actorKind, r.actorId, r.reason, r.userAgent, r.data])).toEqual([
      [
        body.auditId,
        "secret",
        "sso",
        "IdP down, ticket 7",
        "ops/1",
        { organizationId: org, domainId: d.id, domain: "acme.example" },
      ],
    ]);
    // A pending domain takes the override too: it holds no claim, and the answer says so.
    const off = await override(SSO_SECRET, { domainId: pending.id, reason: "Clean up" });
    expect([off.status, await off.json()]).toMatchObject([
      200,
      { verified: false, verifiedAt: null, checkedAt: null, enforce: false },
    ]);
    expect(await auditOf(w, "sso_enforce_off")).toHaveLength(2);
  });

  it("stops the limiter before the resolvers", async () => {
    const w = ssoAuth();
    const d = await added(w, await seedOrganization(w));
    // The record is not published: each verify asks resolver a, which answers [].
    const codes: string[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await verifyDomain(w.config, SSO_APP, { id: d.id });
      codes.push(r.ok ? "ok" : r.code);
    }
    expect(codes).toEqual([...Array(10).fill("domain_unverified"), "rate_limited"]);
    expect(w.a.calls).toHaveLength(10);
    // The first failure ends the check: b is never asked.
    expect(w.b.calls).toHaveLength(0);
  });

  it("names the domain that claims an address, the most specific first", async () => {
    const w = ssoAuth();
    const acme = await seedOrganization(w, "acme");
    const eu = await seedOrganization(w, "eu");
    const parent = await verified(w, acme, "acme.example");
    await verified(w, eu, "eu.acme.example");
    const claim = async (email: string) =>
      (await claimingDomain(w.storage, email))?.claimedDomain ?? null;
    expect(await claim("ada@Acme.Example")).toBe("acme.example");
    expect(await claim("ada@eu.acme.example")).toBe("eu.acme.example");
    // A subdomain with no row of its own needs includeSubdomains on the parent.
    expect(await claim("ada@mail.acme.example")).toBeNull();
    expect(await claim("ada@other.example")).toBeNull();
    const r = await updateDomain(w.config, SSO_APP, { id: parent.id, includeSubdomains: true });
    expect(r.ok).toBe(true);
    expect(await claim("ada@mail.acme.example")).toBe("acme.example");
    expect(await claim("ada@x.eu.acme.example")).toBe("acme.example");
    expect(await inOrganizationDomains(w.storage, acme, "ada@mail.acme.example")).toBe(true);
    expect(await inOrganizationDomains(w.storage, eu, "ada@mail.acme.example")).toBe(false);
    expect(await inOrganizationDomains(w.storage, eu, "ada@eu.acme.example")).toBe(true);
  });

  it("frees the domain of a deleted organization for another organization (ruling 28)", async () => {
    const w = ssoAuth();
    const first = await seedOrganization(w, "first");
    const d = await verified(w, first);
    const owner = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "owner@first.example" },
    ]);
    if (!owner) throw new Error("no owner");
    const gone = await deleteOrganization(w.config, { user: owner, organizationId: first });
    expect(gone.ok).toBe(true);
    expect(
      await w.storage.findOne("ssoDomain", [{ field: "id", op: "eq", value: d.id }]),
    ).toBeNull();
    // The second organization proves the same domain.
    const second = await added(w, await seedOrganization(w, "second"));
    publish(w, second.record);
    const r = await verifyDomain(w.config, SSO_APP, { id: second.id });
    expect(r.ok && r.value.verified).toBe(true);
  });

  it("refuses sso with no resolver and sso with no organizations at construction", () => {
    const input = {
      baseURL: BASE_URL,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [],
      storage: createMemoryAdapter(),
      mail: { send: async () => {} },
      organizations: {},
    };
    const noDefault = "sso.dns must list one DNS resolver or more; core has no default resolver";
    expect(() => resolveConfig({ ...input, sso: {} })).toThrow(new ConfigError(noDefault));
    expect(() => resolveConfig({ ...input, sso: { dns: [] } })).toThrow(new ConfigError(noDefault));
    expect(() => resolveConfig({ ...input, sso: { dns: [{ name: "a" } as never] } })).toThrow(
      ConfigError,
    );
    const { organizations: _, ...bare } = input;
    expect(() => resolveConfig({ ...bare, sso: { dns: [fakeDns("a", {})] } })).toThrow(
      new ConfigError("sso needs organizations"),
    );
    // One resolver is a valid list: the app picks its resolvers.
    expect(resolveConfig({ ...input, sso: { dns: [fakeDns("a", {})] } }).sso?.dns).toHaveLength(1);
  });
});
