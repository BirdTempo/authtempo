import { BetterAuthCompatError } from "./compat-error.js";

/**
 * The host's options of one request (B L2 of the plan 12i final review).
 * `waitUntil` keeps the work that core runs after the answer, such as an
 * SMS or a code mail, alive on a host that freezes the function after the
 * answer. On Next, pass `(p) => after(p)` from `next/server`.
 */
export interface HandlerOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export type HandlerLike =
  | {
      handler(request: Request, options?: HandlerOptions): Promise<Response>;
      options?: unknown;
    }
  | ((request: Request, options?: HandlerOptions) => Promise<Response>);

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

/** The handler of one request. With a `waitUntil`, each request passes it on. */
const handlerOf = (auth: HandlerLike, options: HandlerOptions = {}) => {
  checkIpSetting(auth);
  const handle = typeof auth === "function" ? auth : auth.handler.bind(auth);
  const { waitUntil } = options;
  return waitUntil ? (r: Request) => handle(r, { waitUntil }) : (r: Request) => handle(r);
};

/**
 * Better Auth's `toNextJsHandler(auth)` for a route file
 * `app/api/auth/[...all]/route.ts`. The second argument is authtempo's:
 * `{ waitUntil: (p) => after(p) }`.
 */
export function toNextJsHandler(auth: HandlerLike, options?: HandlerOptions) {
  const h = handlerOf(auth, options);
  return { GET: h, POST: h, PATCH: h, PUT: h, DELETE: h };
}

export { handlerOf };
