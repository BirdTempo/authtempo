import { type Auth, createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";

/** API tokens need no config key: the token routes exist in every deployment. */
export function createTokensAuth(deps: {
  storage: StorageAdapter;
  mail: MailPort;
  secret: string;
}) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
  });
}

/**
 * A route of the app that a script may call. `auth.caller` answers a session,
 * an API token, or an OAuth access token. `auth.session` answers sessions only,
 * so use it in a route that a token must not reach.
 */
export async function whoami(auth: Auth, request: Request): Promise<Response> {
  const c = await auth.caller(request);
  // A client_credentials token and an organization token act for no user, so this route has no one to name.
  if (!c || c.kind === "oauth-client" || c.kind === "organizationToken")
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const res = Response.json({ kind: c.kind, email: c.user.email });
  // After a sliding refresh, renew the cookie, or the browser drops it early.
  const renewed = c.kind === "session" ? auth.sessionCookie(request, c) : null;
  if (renewed) res.headers.append("set-cookie", renewed);
  return res;
}
