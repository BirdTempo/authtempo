import { CAPTCHA_HEADER } from "../../captcha.js";
import type { ResolvedConfig } from "../../config.js";
import { anonymousCaller } from "../../engine/anonymous.js";
import { requireFresh } from "../../engine/fresh.js";
import {
  deletePasskey,
  listPasskeys,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  passkeySignUpOptions,
  renamePasskey,
  signalInputs,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  verifyPasskeySignUp,
} from "../../engine/passkeys.js";
import {
  publicSession,
  renewedSessionCookie,
  sessionFromRequest,
  sessionMaxAgeSeconds,
} from "../../engine/sessions.js";
import type { SessionRow, UserRow } from "../../schema.js";
import {
  authenticateOptionsBody,
  authenticateVerifyBody,
  deleteBody,
  optionsBody,
  registerVerifyBody,
  renameBody,
  signUpOptionsBody,
  signUpVerifyBody,
} from "../contract/passkeys.js";
import { sessionCookie } from "../cookies.js";
import { json, readJson, readOptionalJson, respond } from "../json.js";
import type { Route, RouteContext } from "../router.js";
import { viaField, withLastMethod } from "../session-answer.js";
import { relatedOriginsAnswer, WEBAUTHN_PATH } from "../well-known.js";

export function passkeyRoutes(config: ResolvedConfig): Route[] {
  if (!config.passkey) return [];
  /** The session, plus the renewed cookie when the read moved the expiry. Every session route sends that cookie. */
  const withSession = async (ctx: RouteContext) => {
    const resolved = await sessionFromRequest(ctx.config, ctx.request);
    if (!resolved) return null;
    return {
      user: resolved.user,
      session: resolved.session,
      renewed: renewedSessionCookie(ctx.config, ctx.request, resolved),
    };
  };
  const send = (res: Response, renewed: string | null) => {
    if (renewed) res.headers.append("set-cookie", renewed);
    return res;
  };
  const unauthorized = () => json({ error: "unauthorized" }, 401);
  /** The answer of a sign-in by a passkey: the session, its cookie, and the last method. */
  const signedIn = (
    ctx: RouteContext,
    r: { user: UserRow; session: SessionRow; token: string },
  ): Response => {
    const res = json(
      {
        ...publicSession({ user: r.user, session: r.session, refreshed: false }),
        ...viaField(ctx.config, "passkey"),
      },
      200,
      {
        "set-cookie": sessionCookie(
          ctx.config.cookieName,
          r.token,
          sessionMaxAgeSeconds(ctx.config),
          ctx.config.cookie.sameSite,
        ),
      },
    );
    return withLastMethod(ctx.config, ctx.request, res, "passkey");
  };
  return [
    {
      method: "POST",
      path: "/passkey/register/options",
      key: "POST /passkey/register/options",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        // A new way in: a stolen session must prove the person again (plan 12a).
        // The engine takes a user, so the rule is here, before any write.
        const fresh = requireFresh(ctx.config, s.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        const body = await readOptionalJson(ctx.request, optionsBody);
        if (!body.ok) return send(respond(body), s.renewed);
        return send(
          respond(
            await passkeyRegistrationOptions(ctx.config, {
              user: s.user,
              hints: body.value.hints,
            }),
          ),
          s.renewed,
        );
      },
    },
    {
      method: "POST",
      path: "/passkey/register/verify",
      key: "POST /passkey/register/verify",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const body = await readJson(ctx.request, registerVerifyBody);
        if (!body.ok) return send(respond(body), s.renewed);
        const r = await verifyPasskeyRegistration(ctx.config, {
          user: s.user,
          response: body.value.response,
          name: body.value.name,
        });
        return send(r.ok ? json({ passkey: r.value }) : respond(r), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/passkey/authenticate/options",
      key: "POST /passkey/authenticate/options",
      async handler(ctx) {
        const body = await readOptionalJson(ctx.request, authenticateOptionsBody);
        if (!body.ok) return respond(body);
        return respond(
          await passkeyAuthenticationOptions(ctx.config, {
            ip: ctx.ip,
            hints: body.value.hints,
            extensions: body.value.extensions,
            anonymous: await anonymousCaller(ctx.config, ctx.request),
          }),
        );
      },
    },
    {
      method: "POST",
      path: "/passkey/authenticate/verify",
      key: "POST /passkey/authenticate/verify",
      async handler(ctx) {
        const body = await readJson(ctx.request, authenticateVerifyBody);
        if (!body.ok) return respond(body);
        const r = await verifyPasskeyAuthentication(ctx.config, {
          response: body.value.response,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
          anonymous: await anonymousCaller(ctx.config, ctx.request),
        });
        return r.ok ? signedIn(ctx, r.value) : respond(r);
      },
    },
    // The passkey-first sign-up (plan 12i Task 8). It makes a user with no
    // address. A live anonymous session of the request is replaced (Task 7).
    ...(config.passkey.signUp
      ? [
          {
            method: "POST",
            path: "/passkey/sign-up/options",
            key: "POST /passkey/sign-up/options",
            async handler(ctx: RouteContext) {
              const body = await readJson(ctx.request, signUpOptionsBody);
              if (!body.ok) return respond(body);
              return respond(
                await passkeySignUpOptions(ctx.config, {
                  name: body.value.name,
                  ip: ctx.ip,
                  hints: body.value.hints,
                  captchaToken: ctx.request.headers.get(CAPTCHA_HEADER),
                  anonymous: await anonymousCaller(ctx.config, ctx.request),
                }),
              );
            },
          } satisfies Route,
          {
            method: "POST",
            path: "/passkey/sign-up/verify",
            key: "POST /passkey/sign-up/verify",
            async handler(ctx: RouteContext) {
              const body = await readJson(ctx.request, signUpVerifyBody);
              if (!body.ok) return respond(body);
              const r = await verifyPasskeySignUp(ctx.config, {
                response: body.value.response,
                ip: ctx.ip,
                userAgent: ctx.request.headers.get("user-agent"),
                anonymous: await anonymousCaller(ctx.config, ctx.request),
              });
              return r.ok ? signedIn(ctx, r.value) : respond(r);
            },
          } satisfies Route,
        ]
      : []),
    {
      method: "GET",
      path: "/passkeys",
      key: "GET /passkeys",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        const r = await listPasskeys(ctx.config, { user: s.user });
        const signal = signalInputs(ctx.config, s.user);
        if (!r.ok || !signal.ok) return send(respond(r.ok ? signal : r), s.renewed);
        return send(json({ passkeys: r.value, ...signal.value }), s.renewed);
      },
    },
    {
      method: "POST",
      path: "/passkeys/delete",
      key: "POST /passkeys/delete",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        // The removal of a way in (plan 12a). Before the guard, so a stale
        // session takes no lock and removes nothing.
        const fresh = requireFresh(ctx.config, s.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        const body = await readJson(ctx.request, deleteBody);
        if (!body.ok) return send(respond(body), s.renewed);
        return send(
          respond(await deletePasskey(ctx.config, { user: s.user, id: body.value.id })),
          s.renewed,
        );
      },
    },
    {
      method: "POST",
      path: "/passkeys/rename",
      key: "POST /passkeys/rename",
      async handler(ctx) {
        const s = await withSession(ctx);
        if (!s) return unauthorized();
        // No fresh rule: a name is no way in (plan 12a Task 19).
        const body = await readJson(ctx.request, renameBody);
        if (!body.ok) return send(respond(body), s.renewed);
        return send(
          respond(await renamePasskey(ctx.config, { user: s.user, ...body.value })),
          s.renewed,
        );
      },
    },
    // The related origins document (plan 12i). The browser reads it at the
    // origin root of the rpID host, through auth.wellKnown; this route serves
    // it when core is mounted there. Another host answers not_found.
    ...(config.passkey.relatedOrigins
      ? [
          {
            method: "GET",
            path: WEBAUTHN_PATH,
            key: "GET /.well-known/webauthn",
            handler: async (ctx: RouteContext) =>
              relatedOriginsAnswer(ctx.config, ctx.request) ?? json({ error: "not_found" }, 404),
          } satisfies Route,
        ]
      : []),
  ];
}
