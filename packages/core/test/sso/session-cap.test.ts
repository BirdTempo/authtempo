import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSession, sessionCapHash } from "../../src/engine/sessions.js";
import { sweepExpired } from "../../src/engine/sweep.js";
import { verifyTwoFactor } from "../../src/engine/totp.js";
import { codeNow, enrolled } from "../totp-helpers.js";
import { orgWithSaml, samlSignIn, samlWorld } from "./saml-helpers.js";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY = 86_400_000;
const ADA = "ada@acme.example";

/**
 * The SAML `SessionNotOnOrAfter` caps the session (plan 12d Task 5
 * Behavior 9, ruling 38 Q1, and the Task 5 review l1). The default session
 * lives 30 days and slides after 7, so a cap of 10 days is the earlier one.
 */
describe("the session cap of a SAML sign-in (plan 12d Task 8)", () => {
  it("opens the session at the cap and keeps the cap through a sliding refresh", async () => {
    const w = samlWorld();
    const { idp, connectionId } = await orgWithSaml(w);
    const cap = new Date(w.clock.now().getTime() + 10 * DAY);
    const r = await samlSignIn(w, connectionId, idp, { sessionNotOnOrAfter: cap });
    const opened = await resolveSession(w.config, r.token ?? "");
    expect(opened?.session.expiresAt).toEqual(new Date("2026-01-11T00:00:00.000Z"));
    const row = await w.storage.findOne("verification", [
      { field: "valueHash", op: "eq", value: await sessionCapHash(opened?.session.id ?? "") },
    ]);
    expect(row).toMatchObject({
      purpose: "session-cap",
      identifier: opened?.user.id,
      expiresAt: new Date("2026-01-11T00:00:00.000Z"),
      consumedAt: null,
      data: null,
    });
    // The refresh is due after 7 days. It moves lastSeenAt, never expiresAt past the cap.
    w.clock.advance(7 * DAY + 1);
    const refreshed = await resolveSession(w.config, r.token ?? "");
    expect(refreshed?.refreshed).toBe(true);
    expect(refreshed?.session.expiresAt).toEqual(new Date("2026-01-11T00:00:00.000Z"));
    const stored = await w.storage.findOne("session", [
      { field: "id", op: "eq", value: opened?.session.id ?? "" },
    ]);
    expect(stored?.expiresAt).toEqual(new Date("2026-01-11T00:00:00.000Z"));
    expect(stored?.lastSeenAt).toEqual(new Date("2026-01-08T00:00:00.001Z"));
    w.clock.advance(3 * DAY);
    expect(await resolveSession(w.config, r.token ?? "")).toBeNull();
  });

  it("lets no session at its cap refresh after the sweep deletes its cap row", async () => {
    const w = samlWorld();
    const { idp, connectionId } = await orgWithSaml(w);
    const cap = new Date(w.clock.now().getTime() + 10 * DAY);
    const capRows = () =>
      w.storage.findMany("verification", [{ field: "purpose", op: "eq", value: "session-cap" }]);
    // One session refreshes at the slide time; the other is not seen before the cap.
    const seen = await samlSignIn(w, connectionId, idp, { sessionNotOnOrAfter: cap });
    const unseen = await samlSignIn(w, connectionId, idp, { sessionNotOnOrAfter: cap });
    expect(await capRows()).toHaveLength(2);
    w.clock.advance(7 * DAY + 1);
    // A sweep before the cap keeps both rows: their expiresAt is the cap.
    await sweepExpired(w.config);
    expect(await capRows()).toHaveLength(2);
    expect((await resolveSession(w.config, seen.token ?? ""))?.session.expiresAt).toEqual(cap);
    // One millisecond past the cap, the sweep deletes both rows, and each session is expired.
    w.clock.advance(cap.getTime() - w.clock.now().getTime() + 1);
    await sweepExpired(w.config);
    expect(await capRows()).toEqual([]);
    expect(await resolveSession(w.config, seen.token ?? "")).toBeNull();
    expect(await resolveSession(w.config, unseen.token ?? "")).toBeNull();
    expect(await w.storage.findMany("session", [])).toEqual([]);
  });

  it("slides a session with no cap to the full ttl", async () => {
    const w = samlWorld();
    const { idp, connectionId } = await orgWithSaml(w);
    const r = await samlSignIn(w, connectionId, idp);
    w.clock.advance(7 * DAY + 1);
    const refreshed = await resolveSession(w.config, r.token ?? "");
    expect(refreshed?.session.expiresAt).toEqual(new Date("2026-02-07T00:00:00.001Z"));
    expect(
      await w.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "session-cap" },
      ]),
    ).toEqual([]);
  });

  it("keeps the cap through the second factor challenge", async () => {
    const w = samlWorld();
    const { idp, connectionId } = await orgWithSaml(w);
    const { secret } = await enrolled(w, ADA);
    const cap = new Date(w.clock.now().getTime() + 10 * DAY);
    const r = await samlSignIn(w, connectionId, idp, { sessionNotOnOrAfter: cap });
    if (r.challenge === null) throw new Error("no challenge");
    const v = await verifyTwoFactor(w.config, {
      challenge: r.challenge,
      code: await codeNow(w, secret),
      ip: null,
    });
    if (!v.ok) throw new Error(v.code);
    expect(v.value.session.expiresAt).toEqual(cap);
    w.clock.advance(7 * DAY + 1);
    expect((await resolveSession(w.config, v.value.token))?.session.expiresAt).toEqual(cap);
  });
});
