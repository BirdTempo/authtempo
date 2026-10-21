import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import { hookRefusal } from "../../src/engine/hooks.js";
import { createRole, deleteRole } from "../../src/engine/roles.js";
import { resolveSession } from "../../src/engine/sessions.js";
import { acsUrl } from "../../src/engine/sso/saml-sp.js";
import { randomToken } from "../../src/primitives/crypto.js";
import type { XmlElement } from "../../src/saml/xml.js";
import type { TestResponseInput } from "../../src/testing/saml-idp.js";
import { post } from "../helpers.js";
import {
  attackerKeyInfo,
  type CorpusCase,
  commentInDigestValue,
  commentInNameId,
  doctypeEntity,
  duplicateId,
  NS_SAML,
  secondAssertion,
  sha1Digest,
  unsignedAssertionInSignedResponse,
  xsw1,
  xsw2,
  xsw3,
  xsw4,
  xsw5,
  xsw6,
  xsw7,
  xsw8,
} from "../saml/corpus.js";
import { enrolled } from "../totp-helpers.js";
import {
  b64,
  editAssertion,
  IDP_ORIGIN,
  orgWithSaml,
  postAcs,
  postResponse,
  responseFor,
  rowCounts,
  type SamlExtra,
  type SamlWorld,
  samlConnection,
  samlElement,
  samlSignIn,
  samlStart,
  samlWorld,
} from "./saml-helpers.js";

let error: MockInstance<typeof console.error>;

beforeEach(() => {
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ADA = "ada@acme.example";

/** A refusal of the resolution: a change of the world, the connection, or the IdP's input. */
interface Resolution {
  world?: Partial<AuthConfig>;
  connection?: SamlExtra;
  response?: Partial<TestResponseInput>;
  /** A connection whose dynamic role the owner deletes after the create. */
  goneRole?: true;
}

const refuse = (): never => {
  throw hookRefusal("No one signs in here.");
};

/** One refused condition: a change of the IdP's input, of its signed Assertion, or of the Response text. */
interface Condition {
  extra?: (w: SamlWorld, connectionId: string) => Partial<TestResponseInput>;
  edit?: (assertion: XmlElement) => void;
  text?: (xml: string) => string;
  step: string;
}
const TRANSIENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
const PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

/** The steps of the SSO log lines of one connection, in order. */
function stepsOf(connectionId: string): string[] {
  return error.mock.calls
    .filter((c) => c[0] === "authtempo: sso failed" && c[1] === connectionId)
    .map((c) => String(c[2]));
}

/** The last step that the log names for the connection. */
function lastStep(connectionId: string): string | undefined {
  return stepsOf(connectionId).at(-1);
}

describe("the SAML ACS (plan 12d Task 8)", () => {
  it("signs in through the ACS and opens a session", async () => {
    const w = samlWorld();
    const { idp, connectionId } = await orgWithSaml(w);
    const r = await samlSignIn(w, connectionId, idp);
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get("location")).toBe("https://api.example.com/home");
    expect(r.error).toBeNull();
    const resolved = await resolveSession(w.config, r.token ?? "");
    expect(resolved?.user.email).toBe(ADA);
    const identities = await w.storage.findMany("identity", [
      { field: "userId", op: "eq", value: resolved?.user.id ?? "" },
    ]);
    // The just-in-time user gets its email identity beside the SSO identity.
    expect(identities.map((i) => [i.provider, i.subject]).sort()).toEqual([
      ["email", ADA],
      [`sso:${connectionId}`, "ada-1"],
    ]);
    // The binding cookie goes with the answer: the flow of this browser ends.
    expect(r.res.headers.getSetCookie().some((c) => c.includes("_oauth=; "))).toBe(true);
    // The request row is spent, and the assertion row lives until the later NotOnOrAfter plus the skew.
    const spent = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "saml-request" },
    ]);
    expect(spent.map((v) => v.consumedAt)).toEqual([w.clock.now()]);
    const taken = await w.storage.findMany("verification", [
      { field: "purpose", op: "eq", value: "saml-assertion" },
    ]);
    expect(taken.map((v) => [v.identifier, v.consumedAt, v.expiresAt])).toEqual([
      [connectionId, null, new Date("2026-01-01T00:07:00.000Z")],
    ]);
    // The skew edge passes: NotOnOrAfter 119 seconds ago, inside the skew of 120 seconds.
    const edge = await samlSignIn(w, connectionId, idp, {
      notOnOrAfter: new Date(w.clock.now().getTime() - 119_000),
    });
    expect(edge.token).toMatch(/^ts_/);
  });

  it.each<[string, CorpusCase, string]>([
    ["XSW1", xsw1, "wrapping"],
    ["XSW2", xsw2, "wrapping"],
    ["XSW3", xsw3, "wrapping"],
    ["XSW4", xsw4, "wrapping"],
    ["XSW5", xsw5, "wrapping"],
    ["XSW6", xsw6, "wrapping"],
    ["XSW7", xsw7, "wrapping"],
    ["XSW8", xsw8, "wrapping"],
    ["a comment inside NameID", commentInNameId, "subject"],
    ["a comment inside DigestValue", commentInDigestValue, "digest"],
    ["a second Assertion", secondAssertion, "wrapping"],
    ["a duplicate ID", duplicateId, "wrapping"],
    ["a DOCTYPE", doctypeEntity, "parse"],
    [
      "an unsigned Assertion in a signed Response",
      unsignedAssertionInSignedResponse,
      "signature_shape",
    ],
    ["a SHA-1 digest", sha1Digest, "algorithm"],
    ["a key of the attacker in KeyInfo", attackerKeyInfo, "signature"],
  ])(
    "answers sso_failed to every shape of the corpus at the ACS: %s",
    async (_name, attack, step) => {
      const w = samlWorld();
      const { idp, connectionId } = await orgWithSaml(w);
      const before = await rowCounts(w);
      const start = await samlStart(w, connectionId);
      const valid = await idp.response(responseFor(w, connectionId, start));
      const r = await postResponse(w, connectionId, start, await attack(valid, idp));
      expect([r.res.status, r.error, r.token]).toEqual([302, "sso_failed", null]);
      expect(stepsOf(connectionId)).toEqual([step]);
      expect(await rowCounts(w)).toEqual(before);
    },
  );

  it.each<[string, Condition]>([
    [
      "a wrong Audience",
      { extra: () => ({ audience: "https://sp.example/other/metadata" }), step: "audience" },
    ],
    [
      "a wrong Recipient",
      {
        extra: (w, id) => ({
          recipient: "https://sp.example/other/acs",
          destination: acsUrl(w.config, id),
        }),
        step: "subject_confirmation",
      },
    ],
    [
      "a wrong Destination",
      { extra: () => ({ destination: "https://sp.example/other/acs" }), step: "destination" },
    ],
    [
      "a wrong InResponseTo",
      { extra: () => ({ inResponseTo: "_another_request" }), step: "subject_confirmation" },
    ],
    [
      "a wrong InResponseTo on SubjectConfirmationData only",
      {
        edit: (assertion) => {
          for (const a of samlElement(assertion, "SubjectConfirmationData").attrs)
            if (a.local === "InResponseTo") a.value = "_another_request";
        },
        step: "subject_confirmation",
      },
    ],
    [
      "a wrong InResponseTo on the Response only",
      {
        // The first InResponseTo of the text is the attribute of the unsigned Response.
        text: (xml) => xml.replace(/InResponseTo="[^"]+"/, 'InResponseTo="_another_request"'),
        step: "subject_confirmation",
      },
    ],
    [
      "a NotOnOrAfter one second past the skew",
      {
        extra: (w) => ({ notOnOrAfter: new Date(w.clock.now().getTime() - 121_000) }),
        step: "conditions",
      },
    ],
    [
      "a NotBefore one second past the skew",
      {
        extra: (w) => ({ notBefore: new Date(w.clock.now().getTime() + 121_000) }),
        step: "conditions",
      },
    ],
    [
      "a NotBefore on SubjectConfirmationData",
      {
        edit: (assertion) => {
          samlElement(assertion, "SubjectConfirmationData").attrs.push({
            prefix: null,
            local: "NotBefore",
            ns: null,
            value: "2025-12-31T23:59:00Z",
          });
        },
        step: "subject_confirmation",
      },
    ],
    [
      "a status that is not success",
      {
        text: (xml) =>
          xml.replace(
            "urn:oasis:names:tc:SAML:2.0:status:Success",
            "urn:oasis:names:tc:SAML:2.0:status:Requester",
          ),
        step: "status",
      },
    ],
    [
      "an Assertion Issuer of another IdP",
      { extra: () => ({ issuer: "https://other-idp.example/metadata" }), step: "issuer" },
    ],
    [
      "a SessionNotOnOrAfter that has passed",
      { extra: (w) => ({ sessionNotOnOrAfter: w.clock.now() }), step: "authn_statement" },
    ],
    [
      "an instant with an offset in place of Z",
      {
        edit: (assertion) => {
          for (const a of samlElement(assertion, "Conditions").attrs)
            if (a.local === "NotOnOrAfter") a.value = a.value.replace("Z", "+00:00");
        },
        step: "conditions",
      },
    ],
    [
      "an unknown condition",
      {
        edit: (assertion) => {
          const conditions = samlElement(assertion, "Conditions");
          conditions.children.push({
            kind: "element",
            prefix: "saml",
            local: "ProxyRestriction",
            ns: NS_SAML,
            attrs: [],
            nsDecls: [],
            children: [],
            parent: conditions,
          });
        },
        step: "conditions",
      },
    ],
  ])("refuses the condition: %s", async (_name, condition) => {
    const w = samlWorld();
    const { idp, connectionId } = await orgWithSaml(w);
    const start = await samlStart(w, connectionId);
    const input = responseFor(w, connectionId, start, condition.extra?.(w, connectionId) ?? {});
    let xml = await idp.response(input);
    if (condition.edit) xml = await editAssertion(idp, xml, condition.edit);
    if (condition.text) xml = condition.text(xml);
    const r = await postResponse(w, connectionId, start, xml);
    expect([r.error, r.token]).toEqual(["sso_failed", null]);
    expect(stepsOf(connectionId)).toEqual([condition.step]);
  });

  it("refuses a Response for another connection", async () => {
    const w = samlWorld();
    const a = await orgWithSaml(w, "acme");
    // One IdP serves both organizations: B trusts the key and the entity id of A's IdP.
    const b = await orgWithSaml(w, "beta", {
      idpEntityId: a.idp.entityId,
      certificates: [a.idp.certificatePem],
    });
    const before = await rowCounts(w);
    const startB = await samlStart(w, b.connectionId);
    // Built for connection A, for B's live request, and posted with B's cookie. With no
    // Destination, only the audience tells the two connections apart.
    const xml = await a.idp.response({
      ...responseFor(w, a.connectionId, startB),
      destination: null,
    });
    const r = await postResponse(w, b.connectionId, startB, xml);
    expect([r.error, r.token]).toEqual(["sso_failed", null]);
    expect(stepsOf(b.connectionId)).toEqual(["audience"]);
    expect(await rowCounts(w)).toEqual(before);
  });

  it("refuses a replayed assertion, also under a new request", async () => {
    const w = samlWorld();
    const { idp, connectionId } = await orgWithSaml(w);
    const first = await samlSignIn(w, connectionId, idp);
    expect(first.token).toMatch(/^ts_/);
    const again = await postResponse(w, connectionId, first.start, first.xml);
    expect([again.error, again.token]).toEqual(["sso_failed", null]);
    expect(lastStep(connectionId)).toBe("request_spent");
    // A new start for the same browser, and the old signed Response under the new row.
    const second = await samlStart(w, connectionId);
    const old = await postResponse(w, connectionId, second, first.xml);
    expect([old.error, old.token]).toEqual(["sso_failed", null]);
    expect(lastStep(connectionId)).toBe("subject_confirmation");
    // The IdP signs a Response for the new request with the old Assertion ID.
    const assertionId = /<saml:Assertion ID="([^"]+)"/.exec(first.xml)?.[1];
    if (assertionId === undefined) throw new Error("no Assertion ID");
    const replay = await idp.response(responseFor(w, connectionId, second, { assertionId }));
    const r = await postResponse(w, connectionId, second, replay);
    expect([r.error, r.token]).toEqual(["sso_failed", null]);
    expect(stepsOf(connectionId)).toEqual(["request_spent", "subject_confirmation", "replay"]);
    expect(await w.storage.findMany("session", [])).toHaveLength(1);
  });

  it("refuses an unsolicited Response", async () => {
    const w = samlWorld();
    const { idp, connectionId } = await orgWithSaml(w);
    const xml = await idp.response(responseFor(w, connectionId, { requestId: "_unsolicited" }));
    const before = await rowCounts(w);
    // No start, so no RelayState and no cookie.
    const none = await postAcs(w, connectionId, { SAMLResponse: b64(xml) }, null);
    expect([none.error, none.token]).toEqual(["sso_failed", null]);
    const unknown = await postAcs(
      w,
      connectionId,
      { SAMLResponse: b64(xml), RelayState: randomToken("rs_") },
      null,
    );
    expect(unknown.error).toBe("sso_failed");
    // A second SAMLResponse key is refused at the form step too.
    const start = await samlStart(w, connectionId);
    const twice = new URLSearchParams([
      ["SAMLResponse", b64(xml)],
      ["SAMLResponse", b64(xml)],
      ["RelayState", start.relayState],
    ]);
    expect((await postAcs(w, connectionId, twice, start.bind)).error).toBe("sso_failed");
    // A form over SAML_FORM_MAX bytes: the form step, before any parse.
    const big = await postAcs(
      w,
      connectionId,
      { SAMLResponse: "A".repeat(360_000), RelayState: start.relayState },
      start.bind,
    );
    expect(big.error).toBe("sso_failed");
    // The start's row with no binding cookie: the request step.
    const unbound = await postResponse(w, connectionId, { ...start, bind: "" }, xml);
    expect(unbound.error).toBe("sso_failed");
    expect(stepsOf(connectionId)).toEqual(["form", "request", "form", "form", "request"]);
    expect(await rowCounts(w)).toEqual(before);
  });

  it("reads the subject from the signed Assertion only", async () => {
    const w = samlWorld();
    const { idp, connectionId } = await orgWithSaml(w);
    const start = await samlStart(w, connectionId);
    const valid = await idp.response(responseFor(w, connectionId, start));
    // An unsigned NameID of the attacker in the Response's Extensions, before the Assertion
    // (XML Signature 1.1 section 8.1.3). A new search of the document finds it first.
    const evil = valid.replace(
      "<samlp:Status>",
      `<samlp:Extensions><saml:NameID Format="${PERSISTENT}">evil-1</saml:NameID></samlp:Extensions><samlp:Status>`,
    );
    expect(evil).not.toBe(valid);
    const r = await postResponse(w, connectionId, start, evil);
    const resolved = await resolveSession(w.config, r.token ?? "");
    expect(resolved?.user.email).toBe(ADA);
    const identities = await w.storage.findMany("identity", [
      { field: "provider", op: "eq", value: `sso:${connectionId}` },
    ]);
    expect(identities.map((i) => i.subject)).toEqual(["ada-1"]);
  });

  it("refuses a transient NameID and a split NameID", async () => {
    const w = samlWorld();
    const { idp, connectionId } = await orgWithSaml(w);
    const transient = await samlSignIn(w, connectionId, idp, { nameIdFormat: TRANSIENT });
    expect([transient.error, transient.token]).toEqual(["sso_failed", null]);
    const start = await samlStart(w, connectionId);
    const valid = await idp.response(responseFor(w, connectionId, start));
    const split = await postResponse(w, connectionId, start, await commentInNameId(valid, idp));
    expect([split.error, split.token]).toEqual(["sso_failed", null]);
    expect(stepsOf(connectionId)).toEqual(["subject", "subject"]);
  });

  it("passes the gate on a listed AuthnContextClassRef", async () => {
    const w = samlWorld();
    const mfa = "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor";
    const { idp, connectionId } = await orgWithSaml(w, "acme", { mfa: { authnContext: [mfa] } });
    await enrolled(w, ADA);
    const listed = await samlSignIn(w, connectionId, idp, { authnContext: mfa });
    expect(listed.challenge).toBeNull();
    expect((await resolveSession(w.config, listed.token ?? ""))?.user.email).toBe(ADA);
    const other = await samlSignIn(w, connectionId, idp);
    expect(other.token).toBeNull();
    expect(other.challenge).toMatch(/^tf_/);
  });

  it.each<[string, Resolution]>([
    ["email_required", { response: { attributes: { email: ["not an address"] } } }],
    ["sso_domain_mismatch", { response: { attributes: { email: ["kim@other.example"] } } }],
    ["sso_not_provisioned", { connection: { jit: false } }],
    ["sign_up_closed", { world: { signUp: false } }],
    ["hook_refused", { world: { hooks: { sso: { beforeSignIn: () => refuse() } } } }],
    [
      "hook_failed",
      {
        world: {
          hooks: {
            sso: {
              beforeSignIn: () => {
                throw new Error("a bug of the app");
              },
            },
          },
        },
      },
    ],
    [
      "member_limit",
      {
        world: {
          organizations: {
            ranks: { viewer: 1, member: 2, admin: 3, owner: 4 },
            limits: { membersPerOrganization: 1 },
          },
        },
      },
    ],
    ["role_not_found", { goneRole: true }],
  ])("answers %s of the shared resolution through the ACS", async (code, c) => {
    const w = samlWorld({
      ...c.world,
      ...(c.goneRole
        ? {
            organizations: {
              ranks: { viewer: 1, member: 2, admin: 3, owner: 4 },
              dynamicRoles: {},
            },
          }
        : {}),
    });
    const { idp, connectionId, organizationId } = await orgWithSaml(w, "acme", c.connection);
    let id = connectionId;
    if (c.goneRole) {
      const owner = await w.storage.findOne("user", [
        { field: "email", op: "eq", value: "owner@acme.example" },
      ]);
      if (!owner) throw new Error("no owner");
      const role = { user: owner, organizationId, name: "contractor" };
      const made = await createRole(w.config, {
        ...role,
        rank: 1,
        permissions: { member: ["read"] },
      });
      if (!made.ok) throw new Error(made.code);
      id = await samlConnection(w, organizationId, idp, { defaultRole: "contractor" });
      const gone = await deleteRole(w.config, role);
      if (!gone.ok) throw new Error(gone.code);
    }
    const before = await rowCounts(w);
    const r = await samlSignIn(w, id, idp, c.response);
    expect([r.res.status, r.error, r.token]).toEqual([302, code, null]);
    expect(await rowCounts(w)).toEqual(before);
  });

  it("skips the Origin and Fetch Metadata rules only at the ACS", async () => {
    const w = samlWorld();
    const { connectionId, organizationId } = await orgWithSaml(w);
    // The ACS reaches its handler: the empty form answers the step form, not a 403.
    const acs = await postAcs(w, connectionId, {}, null);
    expect([acs.res.status, acs.error]).toEqual([302, "sso_failed"]);
    expect(stepsOf(connectionId)).toEqual(["form"]);
    const create = await w.handle(
      post(
        "/auth/sso/connections/create",
        { organizationId, kind: "saml", label: "x" },
        { origin: IDP_ORIGIN, "sec-fetch-site": "cross-site" },
      ),
    );
    expect([create.status, await create.json()]).toEqual([403, { error: "origin_not_trusted" }]);
  });
});
