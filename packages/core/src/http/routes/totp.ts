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
import {
  CHALLENGE_PAGE_ERROR,
  codeBody,
  pageBody,
  setupBody,
  verifyBody,
} from "../contract/totp.js";
import { clearTrustCookie, readCookie, trustCookie } from "../cookies.js";
import { noScriptPagePolicy, pageHeaders } from "../csp.js";
import { json, readJson, respond } from "../json.js";
import { authErrorUrl, errorRedirect, redirect, resolveNext } from "../redirect.js";
import type { Route, RouteContext } from "../router.js";
import { sessionCookieFor } from "../session-answer.js";

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
    const resolved = await sessionFromRequest(ctx.config, ctx.request);
    if (!resolved) return null;
    return { resolved, renewed: renewedSessionCookie(ctx.config, ctx.request, resolved) };
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
        const r = await setupTotp(ctx.config, {
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
        const r = await enableTotp(ctx.config, { session: s.resolved, code: body.value.code });
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
        const fresh = requireFresh(ctx.config, s.resolved.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        const body = await readJson(ctx.request, codeBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await disableTotpWithCode(ctx.config, {
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
        const fresh = requireFresh(ctx.config, s.resolved.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        const body = await readJson(ctx.request, codeBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await regenerateBackupCodesWithCode(ctx.config, {
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
        return send(
          respond(await totpStatus(ctx.config, { userId: s.resolved.user.id })),
          s.renewed,
        );
      },
    },
    {
      method: "POST",
      path: "/totp/devices/revoke",
      key: "POST /totp/devices/revoke",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const r = await revokeTrustedDevices(ctx.config, { userId: s.resolved.user.id });
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
        const r = await verifyTwoFactor(ctx.config, { ...body.value, ip: ctx.ip });
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
        const view = await challengeView(ctx.config, {
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
          appName: ctx.config.appName,
          backup: method === "backup",
          trustDays: totp.trustDays,
          error:
            ctx.url.searchParams.get("error") === CHALLENGE_PAGE_ERROR
              ? CHALLENGE_PAGE_ERROR
              : null,
          methods: view.value.methods,
          method,
          trusted: view.value.trusted,
          emailSent: view.value.emailSent,
        });
        return new Response(html, {
          status: 200,
          headers: pageHeaders(ctx.config, noScriptPagePolicy(ctx.config)),
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
        const page = `${ctx.config.baseURL}${challengePath}?challenge=${encodeURIComponent(challenge)}`;
        if (action === "send-email") {
          const sent = await sendSecondFactorEmail(ctx.config, { challenge });
          return sent.ok ? redirect(`${page}&method=email`) : failed(sent.code);
        }
        const r = await verifyTwoFactor(ctx.config, {
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
        if (r.ok) return withCookies(redirect(resolveNext(ctx.config, r.value.next)), r.value);
        // The challenge still lives after a wrong code: send the person back to the form.
        if (r.code === CHALLENGE_PAGE_ERROR)
          return errorRedirect(
            `${page}${backupCode !== undefined ? "&backup=1" : emailCode !== undefined ? "&method=email" : ""}&error=${CHALLENGE_PAGE_ERROR}`,
            CHALLENGE_PAGE_ERROR,
          );
        return failed(r.code);
      },
    },
  ];
}
