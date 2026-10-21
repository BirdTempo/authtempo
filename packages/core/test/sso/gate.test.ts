import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../src/config.js";
import type { SessionVia } from "../../src/engine/hooks.js";
import { resolveSession } from "../../src/engine/sessions.js";
import { updateDomain } from "../../src/engine/sso/domains.js";
import { verifyTwoFactor } from "../../src/engine/totp.js";
import { FAST } from "../password-helpers.js";
import { codeNow, enrolled } from "../totp-helpers.js";
import { SSO_APP, seedOrganization, verifiedDomain } from "./helpers.js";
import { oidcConnection, type SsoWorld, ssoSignIn, ssoSignInWorld } from "./sign-in-helpers.js";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ADA = "ada@acme.example";

/** A world with the second factor on, the organization acme, and its verified domain. */
async function gated(extra: Partial<AuthConfig> = {}) {
  const w = ssoSignInWorld({ password: { hash: FAST, uniformSignUp: false }, ...extra });
  const organizationId = await seedOrganization(w, "acme");
  const domainId = await verifiedDomain(w, organizationId, "acme.example");
  return { w, organizationId, domainId };
}

/** One sign-in of Ada through the connection with `claims` added. */
function signIn(w: SsoWorld, connectionId: string, claims: Record<string, unknown> = {}) {
  return ssoSignIn(w, connectionId, "acme", { sub: "a-1", email: ADA, ...claims });
}

describe("the second factor of an SSO sign-in (plan 12d Task 5)", () => {
  it("passes the gate only on a listed amr, acr, or AuthnContextClassRef", async () => {
    const { w, organizationId } = await gated();
    // Ada turns the factor on through 12c's enable.
    await enrolled(w, ADA);
    const amrList = await oidcConnection(w, organizationId, "acme", { mfa: { amr: ["mfa"] } });
    const noList = await oidcConnection(w, organizationId, "acme", { label: "no list" });
    const acrList = await oidcConnection(w, organizationId, "acme", {
      label: "acr list",
      mfa: { acr: ["phr"] },
    });
    const pwd = await signIn(w, amrList, { amr: ["pwd"] });
    expect(pwd.challenge).toMatch(/^tf_/);
    expect(pwd.token).toBeNull();
    const mfa = await signIn(w, amrList, { amr: ["mfa"] });
    expect(mfa.challenge).toBeNull();
    expect((await resolveSession(w.config, mfa.token ?? ""))?.user.email).toBe(ADA);
    const unlisted = await signIn(w, noList, { amr: ["mfa"] });
    expect(unlisted.challenge).toMatch(/^tf_/);
    expect(unlisted.token).toBeNull();
    const acr = await signIn(w, acrList, { acr: "phr" });
    expect(acr.challenge).toBeNull();
    expect((await resolveSession(w.config, acr.token ?? ""))?.user.email).toBe(ADA);
  });

  it("opens a session with totp.gate.sso false", async () => {
    const { w, organizationId } = await gated({ totp: { gate: { sso: false } } });
    await enrolled(w, ADA);
    const connectionId = await oidcConnection(w, organizationId, "acme");
    const r = await signIn(w, connectionId, { amr: ["pwd"] });
    expect(r.challenge).toBeNull();
    expect((await resolveSession(w.config, r.token ?? ""))?.user.email).toBe(ADA);
  });

  it("verifies the challenge with via sso", async () => {
    const opened: SessionVia[] = [];
    const { w, organizationId, domainId } = await gated({
      hooks: {
        session: {
          afterCreate: (e) => {
            opened.push(e.via);
          },
        },
      },
    });
    const { secret } = await enrolled(w, ADA);
    const connectionId = await oidcConnection(w, organizationId, "acme");
    // With enforce on, the challenge of an SSO sign-in still opens the session (ruling 38).
    const routed = await updateDomain(w.config, SSO_APP, {
      id: domainId,
      connectionId,
      enforce: true,
      ip: null,
      userAgent: null,
    });
    if (!routed.ok) throw new Error(routed.code);
    const r = await signIn(w, connectionId);
    if (r.challenge === null) throw new Error("no challenge");
    opened.length = 0;
    const v = await verifyTwoFactor(w.config, {
      challenge: r.challenge,
      code: await codeNow(w, secret),
      ip: null,
    });
    if (!v.ok) throw new Error(v.code);
    expect(opened).toEqual(["sso"]);
    expect((await resolveSession(w.config, v.value.token))?.session.id).toBe(v.value.session.id);
  });
});
