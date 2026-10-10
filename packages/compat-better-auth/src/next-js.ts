import { BetterAuthCompatError } from "./compat-error.js";

export type HandlerLike =
  | { handler(request: Request): Promise<Response>; options?: unknown }
  | ((request: Request) => Promise<Response>);

/**
 * Off Workers any caller sets `cf-connecting-ip`, core's default IP reader.
 * A host with no IP header setting would then let a caller rotate every
 * per-IP limit (plan 9 final review M-2). So the Node and Next.js handlers
 * need `advanced.ipAddress.ipAddressHeaders` (a non-empty list) or
 * `disableIpTracking: true`. A bare handler function carries no options, so
 * the app owns its IP rule there.
 */
function checkIpSetting(auth: HandlerLike): void {
  if (typeof auth === "function" || auth.options === undefined) return;
  const ip = (
    auth.options as {
      advanced?: { ipAddress?: { ipAddressHeaders?: unknown; disableIpTracking?: unknown } };
    } | null
  )?.advanced?.ipAddress;
  const headers = ip?.ipAddressHeaders;
  if (Array.isArray(headers) && headers.length > 0) return;
  if (ip?.disableIpTracking === true) return;
  throw new BetterAuthCompatError([
    "advanced.ipAddress: off Workers any caller sets cf-connecting-ip, so every per-IP limit can be rotated; set ipAddressHeaders to the header your proxy writes, or disableIpTracking: true",
  ]);
}

const handlerOf = (auth: HandlerLike) => {
  checkIpSetting(auth);
  return typeof auth === "function" ? auth : (r: Request) => auth.handler(r);
};

/** Better Auth's `toNextJsHandler(auth)` for a route file `app/api/auth/[...all]/route.ts`. */
export function toNextJsHandler(auth: HandlerLike) {
  const h = handlerOf(auth);
  return { GET: h, POST: h, PATCH: h, PUT: h, DELETE: h };
}

export { handlerOf };
