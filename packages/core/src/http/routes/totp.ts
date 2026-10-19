import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import { requireFresh } from "../../engine/fresh.js";
import { sendSecondFactorEmail } from "../../engine/second-factor-methods.js";
import {
  publicSession,
  type ResolvedSession,
  renewedSessionCookie,
  sessionFromRequest,
} from "../../engine/sessions.js";
import {
  challengeView,
  disableTotpWithCode,
  enableTotp,
  regenerateBackupCodesWithCode,
  revokeTrustedDevices,
  setupTotp,
  TWO_FACTOR_TOKEN_RE,
  type TwoFactorSession,
  totpStatus,
  verifyTwoFactor,
} from "../../engine/totp.js";
import { readBody } from "../body.js";
import { clearTrustCookie, readCookie, trustCookie } from "../cookies.js";
import { noScriptPagePolicy, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { authErrorUrl, redirect, resolveNext } from "../redirect.js";
import type { Route, RouteContext } from "../router.js";
import { sessionCookieFor } from "../session-answer.js";

const codeBody = z.object({ code: z.string().max(64) });
/** The setup takes the password (plan 9f final fix wave, review I-1); the sign-in's length bound applies in `verifyPassword`. */
const setupBody = z.object({ password: z.string().max(1024) });
const verifyBody = z.object({
  challenge: z.string().max(64),
  code: z.string().max(16).optional(),
  backupCode: z.string().max(64).optional(),
  emailCode: z.string().max(16).optional(),
  // Plan 12c: a WebAuthn assertion; the engine reads only the fields that the seam checks.
  passkey: z.unknown().optional(),
  trustDevice: z.boolean().optional(),
});
/**
 * The challenge page's forms: the checkbox posts `trustDevice=1` when checked
 * and nothing else. `action` (plan 12c) is the send of an email code or the
 * trusted-device button.
 */
const pageBody = z.object({
  challenge: z.string().max(64),
  code: z.string().max(16).optional(),
  backupCode: z.string().max(64).optional(),
  emailCode: z.string().max(16).optional(),
  trustDevice: z.literal("1").optional(),
  action: z.enum(["send-email", "trusted"]).optional(),
});

/**
 * The TOTP routes (plan 9f, spec 8.11). Every route but the verify and the
 * page takes a session through `sessionFromRequest`, which resolves
 * sessions only, so a `tk_` bearer answers 401. No route answers the secret
 * or the key URI after the setup.
 */
export function totpRoutes(config: ResolvedConfig): Route[] {
  const totp = config.totp;
  if (!totp) return [];
  const challengePath = `${config.basePath}/totp/challenge`;
  const trustPath = `${config.basePath}/`;
  const { sameSite } = config.cookie;
  const withSession = async (
    ctx: RouteContext,
  ): Promise<{ resolved: ResolvedSession; renewed: string | null } | null> => {
    const resolved = await sessionFromRequest(config, ctx.request);
    if (!resolved) return null;
    return { resolved, renewed: renewedSessionCookie(config, ctx.request, resolved) };
  };
  const send = (res: Response, renewed: string | null) => {
    if (renewed) res.headers.append("set-cookie", renewed);
    return res;
  };
  const unauthorized = () => json({ error: "unauthorized" }, 401);
  const clearTrust = (res: Response) => {
    res.headers.append("set-cookie", clearTrustCookie(totp.trustCookieName, trustPath, sameSite));
    return res;
  };
  const withCookies = (res: Response, v: TwoFactorSession) => {
    res.headers.append("set-cookie", sessionCookieFor(config, v.token));
    if (v.trustDevice)
      res.headers.append(
        "set-cookie",
        trustCookie(
          totp.trustCookieName,
          v.trustDevice.token,
          trustPath,
          totp.trustDays * 86_400,
          sameSite,
        ),
      );
    return res;
  };
  const failed = (code: string) => redirect(authErrorUrl(config, code));
  return [
    {
      method: "POST",
      path: "/totp/setup",
      key: "POST /totp/setup",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, setupBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await setupTotp(config, {
          userId: s.resolved.user.id,
          password: body.value.password,
          ip: ctx.ip,
        });
        return send(respond(r), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/totp/enable",
      key: "POST /totp/enable",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, codeBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await enableTotp(config, { session: s.resolved, code: body.value.code });
        return send(respond(r), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/totp/disable",
      key: "POST /totp/disable",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        // A change of the second factor needs a fresh session (ASVS 5.0.0
        // 7.5.1; plan 12a). The engine takes a user, so the rule is here,
        // before the engine's code limit.
        const fresh = requireFresh(config, s.resolved.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        const body = await readJson(ctx.request, codeBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await disableTotpWithCode(config, {
          user: s.resolved.user,
          code: body.value.code,
        });
        const res = respond(r);
        return send(r.ok ? clearTrust(res) : res, s.renewed);
      },
    },
    {
      method: "POST",
      path: "/totp/backup-codes",
      key: "POST /totp/backup-codes",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        // New backup codes are a lasting way past the factor, and they void
        // the owner's list (ASVS 5.0.0 7.5.1; plan 12a). Before the code limit.
        const fresh = requireFresh(config, s.resolved.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        const body = await readJson(ctx.request, codeBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await regenerateBackupCodesWithCode(config, {
          user: s.resolved.user,
          code: body.value.code,
        });
        return send(respond(r), s.renewed);
      },
    },
    {
      method: "GET",
      path: "/totp",
      key: "GET /totp",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        return send(respond(await totpStatus(config, { userId: s.resolved.user.id })), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/totp/devices/revoke",
      key: "POST /totp/devices/revoke",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const r = await revokeTrustedDevices(config, { userId: s.resolved.user.id });
        return send(clearTrust(respond(r)), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/totp/verify",
      key: "POST /totp/verify",
      async handler(ctx) {
        const body = await readJson(ctx.request, verifyBody);
        if (!body.ok) return respond(body);
        const r = await verifyTwoFactor(config, { ...body.value, ip: ctx.ip });
        if (!r.ok) return respond(r);
        const v = r.value;
        return withCookies(
          json({
            token: v.token,
            ...publicSession({ user: v.user, session: v.session, refreshed: false }),
            next: v.next,
            backupCodesLeft: v.backupCodesLeft,
            trustDevice: v.trustDevice
              ? { token: v.trustDevice.token, expiresAt: v.trustDevice.expiresAt.toISOString() }
              : null,
          }),
          v,
        );
      },
    },
    {
      // Reads only (plan 12c): the challenge, the factor row, and the trust
      // row, to show the methods and the trusted-device button. No write and
      // no cookie.
      method: "GET",
      path: "/totp/challenge",
      key: "GET /totp/challenge",
      async handler(ctx) {
        const challenge = ctx.url.searchParams.get("challenge") ?? "";
        if (!TWO_FACTOR_TOKEN_RE.test(challenge)) return failed("invalid_token");
        const view = await challengeView(config, {
          challenge,
          trustToken: readCookie(ctx.request, totp.trustCookieName) ?? undefined,
        });
        if (!view.ok) return failed(view.code);
        const asked = ctx.url.searchParams.get("method");
        const wanted =
          ctx.url.searchParams.get("backup") === "1"
            ? "backup"
            : asked === "email" || asked === "totp"
              ? asked
              : null;
        // The first method of the list that a page with no script can serve.
        const served = (["totp", "email", "backup"] as const).filter((m) =>
          view.value.methods.includes(m),
        );
        const method =
          wanted && served.includes(wanted) ? wanted : (served[0] ?? ("backup" as const));
        const html = totp.challengePage({
          action: challengePath,
          challenge,
          appName: config.appName,
          backup: method === "backup",
          trustDays: totp.trustDays,
          error: ctx.url.searchParams.get("error") === "invalid_code" ? "invalid_code" : null,
          methods: view.value.methods,
          method,
          trusted: view.value.trusted,
          emailSent: view.value.emailSent,
        });
        return new Response(html, {
          status: 200,
          headers: pageHeaders(config, noScriptPagePolicy(config)),
        });
      },
    },
    {
      method: "POST",
      path: "/totp/challenge",
      key: "POST /totp/challenge",
      async handler(ctx) {
        const body = await readBody(ctx.request, pageBody);
        if (!body.ok) return failed("invalid_token");
        const { challenge, code, backupCode, emailCode, action } = body.value;
        const page = `${config.baseURL}${challengePath}?challenge=${encodeURIComponent(challenge)}`;
        if (action === "send-email") {
          const sent = await sendSecondFactorEmail(config, { challenge });
          return sent.ok ? redirect(`${page}&method=email`) : failed(sent.code);
        }
        const r = await verifyTwoFactor(config, {
          challenge,
          code,
          backupCode,
          emailCode,
          // The button sends the trust cookie on this same-site post (plan 12c).
          ...(action === "trusted"
            ? { trustToken: readCookie(ctx.request, totp.trustCookieName) ?? "" }
            : {}),
          trustDevice: body.value.trustDevice === "1",
          ip: ctx.ip,
        });
        if (r.ok) return withCookies(redirect(resolveNext(config, r.value.next)), r.value);
        // The challenge still lives after a wrong code: send the person back to the form.
        if (r.code === "invalid_code")
          return redirect(
            `${page}${backupCode !== undefined ? "&backup=1" : emailCode !== undefined ? "&method=email" : ""}&error=invalid_code`,
          );
        return failed(r.code);
      },
    },
  ];
}
