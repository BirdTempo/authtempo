/** A 302 that no cache keeps. Every auth redirect carries a secret or a result. */
export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}
