import type { ResolvedConfig } from "../../config.js";
import { requireFresh } from "../../engine/fresh.js";
import {
  deletePasskey,
  listPasskeys,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  renamePasskey,
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
  registerVerifyBody,
  renameBody,
} from "../contract/passkeys.js";
import { sessionCookie } from "../cookies.js";
import { json, readJson, respond } from "../json.js";
import type { Route, RouteContext } from "../router.js";

// The reauth routes read the credential schema from here (plan 11g: the schema lives in the contract).
export { credentialJson } from "../contract/passkeys.js";

export function passkeyRoutes(config: ResolvedConfig): Route[] {
  if (!config.passkey) return [];
  /** The session, plus the renewed cookie when the read moved the expiry. Every session route sends that cookie. */
  const withSession = async (ctx: RouteContext) => {
    const resolved = await sessionFromRequest(config, ctx.request);
    if (!resolved) return null;
    return {
      user: resolved.user,
      session: resolved.session,
      renewed: renewedSessionCookie(config, ctx.request, resolved),
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
        const fresh = requireFresh(config, s.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        return send(respond(await passkeyRegistrationOptions(config, { user: s.user })), s.renewed);
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
        const r = await verifyPasskeyRegistration(config, {
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
        return respond(await passkeyAuthenticationOptions(config, { ip: ctx.ip }));
      },
    },
    {
      method: "POST",
      path: "/passkey/authenticate/verify",
      key: "POST /passkey/authenticate/verify",
      async handler(ctx) {
        const body = await readJson(ctx.request, authenticateVerifyBody);
        if (!body.ok) return respond(body);
        const r = await verifyPasskeyAuthentication(config, {
          response: body.value.response,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!r.ok) return respond(r);
        const maxAge = sessionMaxAgeSeconds(config);
        return json(
          publicSession({ user: r.value.user, session: r.value.session, refreshed: false }),
          200,
          {
            "set-cookie": sessionCookie(
              config.cookieName,
              r.value.token,
              maxAge,
              config.cookie.sameSite,
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
        const r = await listPasskeys(config, { user: s.user });
        return send(r.ok ? json({ passkeys: r.value }) : respond(r), s.renewed);
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
        const fresh = requireFresh(config, s.session);
        if (!fresh.ok) return send(respond(fresh), s.renewed);
        const body = await readJson(ctx.request, deleteBody);
        if (!body.ok) return send(respond(body), s.renewed);
        return send(
          respond(await deletePasskey(config, { user: s.user, id: body.value.id })),
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
          respond(await renamePasskey(config, { user: s.user, ...body.value })),
          s.renewed,
        );
      },
    },
  ];
}
