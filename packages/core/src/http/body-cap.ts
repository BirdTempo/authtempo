import { readCappedBytes } from "../primitives/read-capped.js";
import type { RouteKey } from "./route-list.js";

/**
 * The request body limits of core (rulings 43 and 46 of the 12j lane). The
 * limits are our own, so no platform limit holds them alone. A cap must
 * also hold under the memory of a Workers isolate (128 MB for all its
 * requests), not only bound the bytes. A parse of 8 MiB of `[[[...]]]`
 * keeps 236 MB, so one global cap of 8 MiB let one body stop an isolate.
 *
 * The derivation, done 2026-10-30. `body-cap.test.ts` walks the body schema
 * of each route of `ROUTE_CONTRACT` and computes its largest valid body. It
 * takes each `max` of length and of items, and 3 bytes for each UTF-16 unit
 * of a string: a character that is not a control character takes at most 3
 * bytes in UTF-8. A form value takes 9 bytes for each unit (`%XX%XX%XX`).
 * A control character other than a line break or a tab takes 6 bytes as a
 * `\u` escape. The count leaves it out, because no field of a route holds
 * one in normal use.
 *
 * Each route gets the next power of two above its own largest valid body,
 * and at least `BODY_CAP_FLOOR`. The test emits the table and fails when a
 * route is above its cap or when a cap is not its derived value.
 */
export const BODY_CAP_FLOOR = 65_536;

/**
 * The routes whose cap is above `BODY_CAP_FLOOR`, from the derivation of
 * 2026-10-30. `POST /social/apple/callback`: 132 537 bytes. The two SSO
 * connection writes: 4 705 616 bytes (`idpMetadata`, `certificates`, and
 * the `mfa` lists). Every other route has a largest body of at most
 * 55 629 bytes (`POST /reauth`). The SSO writes read the body after the
 * session check and the limit of the user (`managedCall` in routes/sso.ts).
 */
export const BODY_CAPS: Readonly<Partial<Record<RouteKey, number>>> = Object.freeze({
  "POST /social/apple/callback": 262_144,
  "POST /sso/connections/create": 8_388_608,
  "POST /sso/connections/update": 8_388_608,
});

/**
 * The largest cap of any route. A framework adapter that buffers a body
 * before core sets its own limit to this value (the Fastify `bodyLimit`).
 */
export const REQUEST_BODY_MAX = 8_388_608;

/**
 * The deepest nesting of `[` and `{` that a JSON body may have. The deepest
 * schema is 4 (`POST /oauth/register`: the body, `jwks`, `keys`, one key).
 * The margin is 12 for the nodes that no schema bounds: a passkey response
 * holds the extension outputs of the client (`prf.results.first` nests 3
 * more levels), and a JWK may hold an array. The test holds both numbers.
 */
export const BODY_DEPTH_MAX = 16;

/**
 * The most items of a JSON body: each `[`, `{`, and `,` outside a string.
 * The largest valid body has 230 items by the schema (the SSO connection
 * update), 329 with `scimRoles` at its engine bound of 100 entries. The
 * next power of two is 512. The limit is 8 times that, for the nodes that
 * no schema bounds: a passkey response, a JWK set, and the keys that an
 * object that is not strict ignores. Each item makes at most one value, so
 * a parsed body holds at most this many values beside its strings, and an
 * 8 MiB body of empty arrays cannot exhaust a 128 MB isolate.
 */
export const BODY_ITEMS_MAX = 4096;

/** The cap of a route: its entry of `BODY_CAPS`, else the floor. */
export function bodyCapOf(key: RouteKey | undefined): number {
  return (key === undefined ? undefined : BODY_CAPS[key]) ?? BODY_CAP_FLOOR;
}

/** The route of each request that the router dispatches. A body read takes the cap of its route. */
const ROUTE_OF = new WeakMap<Request, RouteKey>();

/**
 * Binds `request` to the route that serves it, so `readBodyText` reads at
 * most the cap of that route. The router calls it before each handler. A
 * request with no route reads at most `BODY_CAP_FLOOR`.
 */
export function bindBodyRoute(request: Request, key: RouteKey | undefined): void {
  if (key !== undefined) ROUTE_OF.set(request, key);
}

/** The cap of the body of `request`, by the route that the router bound to it. */
export function bodyCapOfRequest(request: Request): number {
  return bodyCapOf(ROUTE_OF.get(request));
}

/**
 * A request body past the cap of its route, or a body that could not be
 * read. The router answers it 413 `body_too_large` for every route. So a
 * route that maps its own failures, such as a form post that redirects,
 * cannot hide the cap.
 */
export class BodyTooLarge extends Error {
  readonly cap: number;
  constructor(cap: number) {
    super(`the request body is more than ${cap} bytes`);
    this.name = "BodyTooLarge";
    this.cap = cap;
  }
}

/**
 * The request body as text, at most `cap` bytes (the cap of the request's
 * route by default). The read is a stream read that stops at the cap, so a
 * false or absent `content-length` cannot pass it. A declared length past
 * the cap stops the read before the first byte. It throws `BodyTooLarge`
 * past the cap, on a read error, and when the request aborts. The decode is
 * that of `request.text()`: UTF-8, with a replacement character for a bad
 * byte and a leading BOM removed. Workers, Node, Bun, and Deno each give
 * `request.body` as a stream.
 */
export async function readBodyText(
  request: Request,
  cap: number = bodyCapOfRequest(request),
): Promise<string> {
  const length = request.headers.get("content-length");
  // The SCIM body read wraps the stream the same way (routes/scim.ts).
  const bytes = await readCappedBytes(
    new Response(request.body, length === null ? {} : { headers: { "content-length": length } }),
    cap,
    request.signal,
  );
  if (bytes === null) throw new BodyTooLarge(cap);
  return new TextDecoder().decode(bytes);
}

/**
 * True when the JSON text nests `[` and `{` at most `BODY_DEPTH_MAX` deep
 * and has at most `BODY_ITEMS_MAX` items outside its strings. One pass over
 * the text, before `JSON.parse`, so a body that would take more memory than
 * its bytes never becomes values. The scan does not check the grammar:
 * `JSON.parse` does that next.
 */
export function jsonShapeFits(text: string): boolean {
  let depth = 0;
  let items = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      // A backslash takes the next unit with it, so `\"` does not end the string.
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      depth++;
      items++;
      if (depth > BODY_DEPTH_MAX || items > BODY_ITEMS_MAX) return false;
    } else if (c === 0x5d || c === 0x7d) depth--;
    else if (c === 0x2c && ++items > BODY_ITEMS_MAX) return false;
  }
  return true;
}

/** The value of a JSON body text, or `undefined` for text that is not JSON or does not fit the shape limits. */
export function parseBodyJson(text: string): unknown {
  if (!jsonShapeFits(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
