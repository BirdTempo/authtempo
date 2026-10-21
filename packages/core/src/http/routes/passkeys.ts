import type { ResolvedConfig } from "../../config.js";
import { requireFresh } from "../../engine/fresh.js";
import {
  deletePasskey,
  listPasskeys,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  renamePasskey,
  signalInputs,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../../engine/passkeys.js";
import {
  publicSession,
  renewedSessionCookie,
  sessionFromRequest,
  sessionMaxAgeSeconds,
} from "../../engine/sessions.js";
import {
  authenticateVerifyBody,
  deleteBody,
  optionsBody,
  registerVerifyBody,
  renameBody,
} from "../contract/passkeys.js";
import { sessionCookie } from "../cookies.js";
import { json, readJson, readOptionalJson, respond } from "../json.js";
import type { Route, RouteContext } from "../router.js";
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
        const body = await readOptionalJson(ctx.request, optionsBody);
        if (!body.ok) return respond(body);
        return respond(
          await passkeyAuthenticationOptions(ctx.config, { ip: ctx.ip, hints: body.value.hints }),
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
        });
        if (!r.ok) return respond(r);
        const maxAge = sessionMaxAgeSeconds(ctx.config);
        return json(
          publicSession({ user: r.value.user, session: r.value.session, refreshed: false }),
          200,
          {
            "set-cookie": sessionCookie(
              ctx.config.cookieName,
              r.value.token,
              maxAge,
              ctx.config.cookie.sameSite,
            ),
          },
        );
      },
    },
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
