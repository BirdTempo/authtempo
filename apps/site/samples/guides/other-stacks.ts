import type { Auth } from "@authtempo/core";

/**
 * One fetch handler for any runtime that speaks the web Request and Response:
 * `Bun.serve({ fetch })`, `Deno.serve(fetch)`, or `export default { fetch }` on Workers.
 * It matches the raw path of `request.url`, the path that core's router reads:
 * no decode, with case, and no trailing slash cut. An exact match covers one path only.
 */
export function createFetchHandler(auth: Auth): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    // RFC 8414 and RFC 9728 put the metadata at the origin root.
    if (url.pathname.startsWith("/.well-known/")) return auth.wellKnown(request);
    if (url.pathname.startsWith("/auth/")) return auth.handle(request);
    if (url.pathname === "/me") {
      const session = await auth.session(request);
      if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
      const res = Response.json({ email: session.user.email });
      // After a sliding refresh, renew the cookie, or the browser drops it early.
      const renewed = auth.sessionCookie(request, session);
      if (renewed) res.headers.set("set-cookie", renewed);
      return res;
    }
    return new Response("not found", { status: 404 });
  };
}
