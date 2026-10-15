import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { isFresh, requireFresh } from "../src/engine/fresh.js";
import { passwordSignIn } from "../src/engine/password.js";
import { reauthenticate } from "../src/engine/reauth.js";
import { resolveSession } from "../src/engine/sessions.js";
import { verifyTwoFactor } from "../src/engine/totp.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { post } from "./helpers.js";
import { sessionOnly } from "./password-helpers.js";
import {
  type Auth,
  codeNow,
  EMAIL,
  enrolled,
  PASSWORD,
  totpAuth,
  verifiedSession,
  wrongFor,
} from "./totp-helpers.js";

const DAY = 86_400_000;

/** The session of `token` one day later: alive (30 days), no longer fresh (24 hours). */
async function stale(auth: Auth, token: string) {
  auth.clock.advance(DAY);
  const s = await resolveSession(auth.config, token);
  if (!s) throw new Error("the session ended");
  return s;
}

function handler(auth: Auth) {
  return createRouter(auth.config, coreRoutes(auth.config));
}

describe("the fresh rule (plan 12a, spec 8.15, ASVS 5.0.0 7.5.1)", () => {
  it("defaults the window to 24 hours and refuses a window outside 1 to 1440 minutes", () => {
    expect(totpAuth().config.session.freshMinutes).toBe(1440);
    expect(totpAuth({ session: { freshMinutes: 5 } }).config.session.freshMinutes).toBe(5);
    for (const freshMinutes of [0, 1441, 1.5])
      expect(() => totpAuth({ session: { freshMinutes } })).toThrow(
        new ConfigError("session.freshMinutes must be an integer from 1 to 1440"),
      );
  });

  it("is fresh 1 ms before the window ends, and not at its end or with a null freshAt", () => {
    const auth = totpAuth({ session: { freshMinutes: 15 } });
    const at = new Date("2026-10-14T00:00:00.000Z");
    const end = at.getTime() + 15 * 60_000;
    expect(isFresh(auth.config, { freshAt: at }, new Date(end - 1))).toBe(true);
    expect(isFresh(auth.config, { freshAt: at }, new Date(end))).toBe(false);
    expect(isFresh(auth.config, { freshAt: null }, at)).toBe(false);
  });

  it("a stale session is refused and passes after a re-authentication with the same token and expiry", async () => {
    const auth = totpAuth();
    const signedIn = await verifiedSession(auth);
    expect(requireFresh(auth.config, signedIn.session)).toEqual({ ok: true, value: true });
    const old = await stale(auth, signedIn.token);
    expect(requireFresh(auth.config, old.session)).toMatchObject({
      ok: false,
      code: "session_not_fresh",
      status: 403,
    });
    const r = await reauthenticate(auth.config, {
      session: old,
      proof: { password: PASSWORD },
      ip: null,
    });
    expect(r).toEqual({
      ok: true,
      value: { freshUntil: new Date(auth.clock.now().getTime() + DAY) },
    });
    const after = await resolveSession(auth.config, signedIn.token);
    expect(after?.session.id).toBe(old.session.id);
    expect(after?.session.expiresAt).toEqual(old.session.expiresAt);
    expect(after?.session.freshAt).toEqual(auth.clock.now());
    if (!after) throw new Error("the session ended");
    expect(requireFresh(auth.config, after.session).ok).toBe(true);
  });
});

describe("POST /reauth with the password (plan 12a)", () => {
  it("refuses a wrong password, and the session stays stale", async () => {
    const auth = totpAuth();
    const old = await stale(auth, (await verifiedSession(auth)).token);
    const r = await reauthenticate(auth.config, {
      session: old,
      proof: { password: "a wrong password" },
      ip: null,
    });
    expect(r).toMatchObject({ ok: false, code: "invalid_credentials" });
    const row = await auth.storage.findOne("session", [
      { field: "id", op: "eq", value: old.session.id },
    ]);
    expect(row?.freshAt).toEqual(old.session.freshAt);
  });

  it("a wrong password at the re-authentication does not hold the owner's sign-in", async () => {
    const auth = totpAuth();
    const old = await stale(auth, (await verifiedSession(auth)).token);
    for (let i = 0; i < 10; i++)
      expect(
        await reauthenticate(auth.config, {
          session: old,
          proof: { password: "a wrong password" },
          ip: null,
        }),
      ).toMatchObject({ code: "invalid_credentials" });
    expect(
      await reauthenticate(auth.config, { session: old, proof: { password: PASSWORD }, ip: null }),
    ).toMatchObject({ code: "rate_limited" });
    const s = await sessionOnly(
      passwordSignIn(auth.config, { email: EMAIL, password: PASSWORD, ip: null, userAgent: null }),
    );
    expect(s.ok).toBe(true);
  });

  it("asks for the second-factor code when the factor is on, and takes a code or a backup code", async () => {
    const auth = totpAuth();
    const { session, secret, backupCodes } = await enrolled(auth);
    const old = await stale(auth, session.token);
    expect(
      await reauthenticate(auth.config, { session: old, proof: { password: PASSWORD }, ip: null }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    const code = await codeNow(auth, secret);
    expect(
      await reauthenticate(auth.config, {
        session: old,
        proof: { password: PASSWORD, code: wrongFor(code) },
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_code" });
    expect(
      (
        await reauthenticate(auth.config, {
          session: old,
          proof: { password: PASSWORD, code },
          ip: null,
        })
      ).ok,
    ).toBe(true);
    auth.clock.advance(DAY);
    const backup = backupCodes[0] ?? "";
    expect(
      (
        await reauthenticate(auth.config, {
          session: old,
          proof: { password: PASSWORD, code: backup },
          ip: null,
        })
      ).ok,
    ).toBe(true);
  });

  it("answers unauthorized for a session that ended before the write", async () => {
    const auth = totpAuth();
    const old = await stale(auth, (await verifiedSession(auth)).token);
    await auth.storage.delete("session", [{ field: "id", op: "eq", value: old.session.id }]);
    expect(
      await reauthenticate(auth.config, { session: old, proof: { password: PASSWORD }, ip: null }),
    ).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("serves the route: a session answers freshUntil, a token or nothing answers 401, an unknown field 400", async () => {
    const auth = totpAuth();
    const handle = handler(auth);
    const { token } = await verifiedSession(auth);
    const ok = await handle(
      post("/auth/reauth", { password: PASSWORD }, { authorization: `Bearer ${token}` }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      freshUntil: new Date(auth.clock.now().getTime() + DAY).toISOString(),
    });
    const none = await handle(post("/auth/reauth", { password: PASSWORD }));
    expect(none.status).toBe(401);
    const apiToken = await handle(
      post(
        "/auth/reauth",
        { password: PASSWORD },
        { authorization: `Bearer tk_${"a".repeat(43)}` },
      ),
    );
    expect(apiToken.status).toBe(401);
    const extra = await handle(
      post(
        "/auth/reauth",
        { password: PASSWORD, remember: true },
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(extra.status).toBe(400);
    expect(await extra.json()).toEqual({ error: "invalid_body" });
  });

  it("takes no trust cookie in place of the code", async () => {
    const auth = totpAuth();
    const { secret, session } = await enrolled(auth);
    const signIn = await passwordSignIn(auth.config, {
      email: EMAIL,
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!signIn.ok || "token" in signIn.value) throw new Error("the sign-in answered no challenge");
    const verified = await verifyTwoFactor(auth.config, {
      challenge: signIn.value.twoFactor.challenge,
      code: await codeNow(auth, secret),
      trustDevice: true,
      ip: null,
    });
    if (!verified.ok || !verified.value.trustDevice) throw new Error("no trusted device");
    const trust = `${auth.config.totp?.trustCookieName}=${verified.value.trustDevice.token}`;
    const bearer = session.token;
    const res = await handler(auth)(
      post(
        "/auth/reauth",
        { password: PASSWORD },
        { authorization: `Bearer ${bearer}`, cookie: trust },
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });
});
