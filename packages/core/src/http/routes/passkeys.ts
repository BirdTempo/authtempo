import { z } from "zod";
import type { ResolvedConfig } from "../../config.js";
import {
  deletePasskey,
  listPasskeys,
  passkeyAuthenticationOptions,
  passkeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "../../engine/passkeys.js";
import { publicSession, readSessionToken, resolveSession } from "../../engine/sessions.js";
import { sessionCookie } from "../cookies.js";
import { json, readJson, respond } from "../json.js";
import type { Route, RouteContext } from "../router.js";

/** The browser's `PublicKeyCredential.toJSON()`. Only the fields the engine reads are checked; the seam checks the rest. */
const credentialJson = z
  .object({
    id: z.string().min(1).max(1024),
    response: z.object({ clientDataJSON: z.string().min(1).max(16_384) }).loose(),
  })
  .loose();

const registerVerifyBody = z.object({
  response: credentialJson,
  name: z.string().max(64).optional(),
});
const authenticateVerifyBody = z.object({ response: credentialJson });
const deleteBody = z.object({ id: z.string().min(1).max(64) });

export function passkeyRoutes(config: ResolvedConfig): Route[] {
  if (!config.passkey) return [];
  const withUser = async (ctx: RouteContext) => {
    const token = readSessionToken(config, ctx.request);
    const resolved = token ? await resolveSession(config, token) : null;
    return resolved?.user ?? null;
  };
  const unauthorized = () => json({ error: "unauthorized" }, 401);
  return [
    {
      method: "POST",
      path: "/passkey/register/options",
      async handler(ctx) {
        const user = await withUser(ctx);
        if (!user) return unauthorized();
        return respond(await passkeyRegistrationOptions(config, { user }));
      },
    },
    {
      method: "POST",
      path: "/passkey/register/verify",
      async handler(ctx) {
        const user = await withUser(ctx);
        if (!user) return unauthorized();
        const body = await readJson(ctx.request, registerVerifyBody);
        if (!body.ok) return respond(body);
        const r = await verifyPasskeyRegistration(config, {
          user,
          response: body.value.response,
          name: body.value.name,
        });
        return r.ok ? json({ passkey: r.value }) : respond(r);
      },
    },
    {
      method: "POST",
      path: "/passkey/authenticate/options",
      async handler(ctx) {
        return respond(await passkeyAuthenticationOptions(config, { ip: ctx.ip }));
      },
    },
    {
      method: "POST",
      path: "/passkey/authenticate/verify",
      async handler(ctx) {
        const body = await readJson(ctx.request, authenticateVerifyBody);
        if (!body.ok) return respond(body);
        const r = await verifyPasskeyAuthentication(config, {
          response: body.value.response,
          ip: ctx.ip,
          userAgent: ctx.request.headers.get("user-agent"),
        });
        if (!r.ok) return respond(r);
        const maxAge = config.session.ttlDays * 86_400;
        return json(
          publicSession({ user: r.value.user, session: r.value.session, refreshed: false }),
          200,
          {
            "set-cookie": sessionCookie(config.cookieName, r.value.token, maxAge),
          },
        );
      },
    },
    {
      method: "GET",
      path: "/passkeys",
      async handler(ctx) {
        const user = await withUser(ctx);
        if (!user) return unauthorized();
        const r = await listPasskeys(config, { user });
        return r.ok ? json({ passkeys: r.value }) : respond(r);
      },
    },
    {
      method: "POST",
      path: "/passkeys/delete",
      async handler(ctx) {
        const user = await withUser(ctx);
        if (!user) return unauthorized();
        const body = await readJson(ctx.request, deleteBody);
        if (!body.ok) return respond(body);
        return respond(await deletePasskey(config, { user, id: body.value.id }));
      },
    },
  ];
}
