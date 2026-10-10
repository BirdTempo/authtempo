export type HandlerLike =
  | { handler(request: Request): Promise<Response> }
  | ((request: Request) => Promise<Response>);

const handlerOf = (auth: HandlerLike) =>
  typeof auth === "function" ? auth : (r: Request) => auth.handler(r);

/** Better Auth's `toNextJsHandler(auth)` for a route file `app/api/auth/[...all]/route.ts`. */
export function toNextJsHandler(auth: HandlerLike) {
  const h = handlerOf(auth);
  return { GET: h, POST: h, PATCH: h, PUT: h, DELETE: h };
}

export { handlerOf };
