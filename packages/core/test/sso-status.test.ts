import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoConfig } from "../src/config.js";
import { createScimToken } from "../src/engine/scim/tokens.js";
import { listConnections } from "../src/engine/sso/connections.js";
import type { AuthEvent } from "../src/observe/port.js";
import { parseXml } from "../src/saml/xml.js";
import { attrOf, createTestIdp } from "../src/testing/saml-idp.js";
import { get, recordCredential } from "./helpers.js";
import { scim, scimAuth } from "./scim/helpers.js";
import { SSO_APP } from "./sso/helpers.js";
import {
  inflateRequest,
  postAcs,
  postResponse,
  responseFor,
  samlConnection,
  samlSignIn,
} from "./sso/saml-helpers.js";
import { acmeWithSso, ssoSignIn, ssoSignInWorld } from "./sso/sign-in-helpers.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BIND = "__Secure-tempo_session_oauth";

beforeEach(() => {
  // A refused step writes one log line; the tests read the rows and the events.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/**
 * The world of `scimAuth` with SAML and the setup links on, a sink of the events, and one SAML
 * connection of acme. The setup links turn on the test run.
 */
async function world() {
  const batches: AuthEvent[][] = [];
  const w = await scimAuth({
    sso: { saml: true, setup: {} } as SsoConfig,
    observe: { sink: { write: (b) => void batches.push([...b]) } },
  });
  const idp = await createTestIdp({ alg: "rsa" });
  const rogue = await createTestIdp({ alg: "rsa", entityId: idp.entityId });
  const connectionId = await samlConnection(w, w.org, idp);
  const events = async () => {
    await w.config.observe.flush();
    return batches.flat();
  };
  return { ...w, idp, rogue, connectionId, events };
}
type World = Awaited<ReturnType<typeof world>>;

const rowOf = async (w: World) => {
  const row = await w.storage.findOne("ssoConnection", [
    { field: "id", op: "eq", value: w.connectionId },
  ]);
  if (!row) throw new Error("no row");
  return row;
};

/** The status of the connection in the list, as the manager reads it. */
async function statusOf(w: World) {
  const listed = await listConnections(w.config, SSO_APP, { organizationId: w.org });
  if (!listed.ok) throw new Error(listed.code);
  return listed.value.find((c) => c.id === w.connectionId)?.status;
}

/** The time of the clock at `hour`:`minute` of the first day of the test clock. */
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 0, 1, hour, minute)).toISOString();

/** Moves the clock of the world to the time `iso`. */
function moveTo(w: World, iso: string) {
  w.clock.advance(new Date(iso).getTime() - w.clock.now().getTime());
}

/** The updates of the connection row that a call makes. */
function connectionWrites(w: World) {
  const spy = vi.spyOn(w.config.storage, "update");
  return () => spy.mock.calls.filter(([model]) => model === "ssoConnection").length;
}

/** A SAML test run of a manager through the routes: the start with the session, then the post. */
async function managerTest(w: World, signer: World["idp"]) {
  const res = await w.handle(
    get(`/auth/sso/${w.connectionId}/start?test=1`, {
      cookie: `__Host-tempo_session=${w.owner.token}`,
    }),
  );
  if (res.status !== 302) throw new Error(`the start answered ${res.status}`);
  const location = new URL(res.headers.get("location") ?? "");
  const parsed = parseXml(await inflateRequest(location.searchParams.get("SAMLRequest") ?? ""));
  if (!parsed.ok) throw new Error("the AuthnRequest does not parse");
  const bind =
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${BIND}=`))
      ?.split(";")[0]
      ?.split("=")[1] ?? "";
  const start = {
    requestId: attrOf(parsed.root, "ID") ?? "",
    relayState: location.searchParams.get("RelayState") ?? "",
    bind,
  };
  const xml = await signer.response(responseFor(w, w.connectionId, start));
  return postResponse(w, w.connectionId, start, xml);
}

describe("the status of a connection (plan 13b Task 9)", () => {
  it("status hour: failures at 10:30 and 11:00 after one at 10:00 make one write, at 11:00", async () => {
    const w = await world();
    moveTo(w, at(10));
    expect((await samlSignIn(w, w.connectionId, w.rogue)).error).toBe("sso_failed");
    const first = await rowOf(w);
    expect(first.lastFailureAt?.toISOString()).toBe(at(10));
    expect(first.lastFailureStep).toBe("signature");
    const writes = connectionWrites(w);
    moveTo(w, at(10, 30));
    expect((await samlSignIn(w, w.connectionId, w.rogue)).error).toBe("sso_failed");
    expect([writes(), (await rowOf(w)).lastFailureAt?.toISOString()]).toEqual([0, at(10)]);
    moveTo(w, at(11));
    expect((await samlSignIn(w, w.connectionId, w.rogue)).error).toBe("sso_failed");
    expect([writes(), (await rowOf(w)).lastFailureAt?.toISOString()]).toEqual([1, at(11)]);
  });

  it("status success: a real sign-in sets lastSuccessAt, and the list shows it", async () => {
    const w = await world();
    moveTo(w, at(9));
    const before = await rowOf(w);
    const signed = await samlSignIn(w, w.connectionId, w.idp);
    expect(signed.token).not.toBeNull();
    expect(await statusOf(w)).toEqual({
      lastSuccessAt: at(9),
      lastFailureAt: null,
      lastFailureStep: null,
      certificateEndsAt: "2045-01-01T00:00:00.000Z",
      expiryStage: null,
    });
    // The status write keeps updatedAt, the lock of an update of the manager.
    expect((await rowOf(w)).updatedAt).toEqual(before.updatedAt);
    // A second sign-in in the same hour writes nothing.
    const writes = connectionWrites(w);
    moveTo(w, at(9, 59));
    expect((await samlSignIn(w, w.connectionId, w.idp)).token).not.toBeNull();
    expect([writes(), (await statusOf(w))?.lastSuccessAt]).toEqual([0, at(9)]);
  });

  it("test run: a test sign-in of a manager, passed or failed, leaves the status as it was", async () => {
    const w = await world();
    const before = await statusOf(w);
    expect(before).toEqual({
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureStep: null,
      certificateEndsAt: "2045-01-01T00:00:00.000Z",
      expiryStage: null,
    });
    // Each test run answers with a redirect and opens no session.
    for (const signer of [w.rogue, w.idp]) expect((await managerTest(w, signer)).token).toBeNull();
    // The ids are random, so the outcomes are sorted.
    const runs = await w.storage.findMany("ssoTestRun", []);
    expect(runs.map((r) => r.outcome).sort()).toEqual(["failed", "passed"]);
    expect(await statusOf(w)).toEqual(before);
  });

  it("event: a failure names the organization of the connection", async () => {
    const w = await world();
    await samlSignIn(w, w.connectionId, w.rogue);
    const failed = (await w.events()).filter((e) => e.name === "sso.failed");
    expect(failed.map((e) => [e.connectionId, e.organizationId, e.step])).toEqual([
      [w.connectionId, w.org, "signature"],
    ]);
  });

  it("event: a failure before the read of the connection has no organizationId and no rejected field", async () => {
    const w = await world();
    // A post with no SAMLResponse stops at the form step, before the read of the connection.
    expect((await postAcs(w, w.connectionId, { RelayState: "x" }, null)).error).toBe("sso_failed");
    const failed = (await w.events()).filter((e) => e.name === "sso.failed");
    expect(
      failed.map((e) => [e.step, Object.hasOwn(e, "organizationId"), e.rejected ?? []]),
    ).toEqual([["form", false, []]]);
  });

  it("event: a refusal of the resolution names the organization of the connection", async () => {
    const w = await world();
    // The address is outside the verified domains of acme.
    await samlSignIn(w, w.connectionId, w.idp, { attributes: { email: ["ada@other.example"] } });
    const refused = (await w.events()).filter((e) => e.name === "sso.refused");
    expect(refused.map((e) => [e.connectionId, e.organizationId])).toEqual([
      [w.connectionId, w.org],
    ]);
  });

  it("event: an OIDC failure after the read of the connection names the organization and writes the status", async () => {
    const batches: AuthEvent[][] = [];
    const w = ssoSignInWorld({ observe: { sink: { write: (b) => void batches.push([...b]) } } });
    const { organizationId, connectionId } = await acmeWithSso(w);
    // The ID token names the audience of another client: the check of the token fails.
    const r = await ssoSignIn(w, connectionId, "other", {
      sub: "ada-1",
      email: "ada@acme.example",
    });
    expect(r.error).toBe("sso_failed");
    await w.config.observe.flush();
    const failed = batches.flat().filter((e) => e.name === "sso.failed");
    const row = await w.storage.findOne("ssoConnection", [
      { field: "id", op: "eq", value: connectionId },
    ]);
    expect([
      failed.map((e) => [e.organizationId, e.step]),
      row?.lastFailureStep,
      row?.lastFailureAt,
    ]).toEqual([[[organizationId, "id_token"]], "id_token", w.clock.now()]);
  });

  it("keeps the sign-in when the status write throws, and writes one fault event", async () => {
    const w = await world();
    const update = w.config.storage.update.bind(w.config.storage);
    vi.spyOn(w.config.storage, "update").mockImplementation((model, where, changes) =>
      model === "ssoConnection"
        ? Promise.reject(new Error("the store is gone"))
        : update(model, where, changes),
    );
    const signed = await samlSignIn(w, w.connectionId, w.idp);
    expect(signed.token).not.toBeNull();
    const faults = (await w.events()).filter((e) => e.name === "sso.status_write_failed");
    expect(faults.map((e) => [e.connectionId, e.errorName])).toEqual([[w.connectionId, "Error"]]);
  });
});

describe("the expiry fields of a row from before schema 18 (plan 13b Task 9, decision 6)", () => {
  it("fills the certificate end and the notice of a SAML row at its first sign-in", async () => {
    const w = await world();
    // The migration to schema 18 adds the fields as null to each row.
    await w.storage.update("ssoConnection", [{ field: "id", op: "eq", value: w.connectionId }], {
      certificateEndsAt: null,
      expiryStage: null,
      expiryNoticeAt: null,
    });
    const writes = connectionWrites(w);
    expect((await samlSignIn(w, w.connectionId, w.idp)).token).not.toBeNull();
    const row = await rowOf(w);
    expect([
      writes(),
      row.certificateEndsAt?.toISOString(),
      row.expiryStage,
      row.expiryNoticeAt?.toISOString(),
    ]).toEqual([1, "2045-01-01T00:00:00.000Z", null, "2044-12-02T00:00:00.000Z"]);
  });

  it("fills the notice of a SCIM token at its first call, in the update of lastUsedAt", async () => {
    const w = await world();
    const made = await createScimToken(w.config, SSO_APP, {
      organizationId: w.org,
      name: "directory",
      expiresInDays: 45,
    });
    if (!made.ok) throw new Error(made.code);
    recordCredential(made.value.token);
    const byId = [{ field: "id", op: "eq", value: made.value.id }] as const;
    const end = (await w.storage.findOne("scimToken", [...byId]))?.expiresAt;
    if (!end) throw new Error("no end");
    // The migration to schema 18 adds the expiry fields as null to each row.
    await w.storage.update("scimToken", [...byId], { expiryStage: null, expiryNoticeAt: null });
    w.clock.advance(DAY_MS);
    const writes = vi.spyOn(w.config.storage, "update");
    expect((await scim(w, made.value.token, "GET", "/Users")).status).toBe(200);
    const token = await w.storage.findOne("scimToken", [...byId]);
    expect([
      writes.mock.calls.filter(([model]) => model === "scimToken").length,
      token?.expiryNoticeAt,
    ]).toEqual([1, new Date(end.getTime() - 30 * DAY_MS)]);
  });
});
