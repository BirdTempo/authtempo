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
 * The count leaves out two forms of 6 bytes for one unit: the `\u` escape
 * of a control character other than a line break or a tab, and the `\u`
 * escape that an ASCII-only encoder (such as the default of Python's
 * `json.dumps`) writes for each unit that is not ASCII. No field of a route
 * holds a control character in normal use. A body of such an encoder can
 * take up to twice the count. When most of its text is not ASCII, it can
 * pass the cap and answer 413: such a client must send UTF-8 for long text.
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

/**
 * The most pairs of a form body: one more than its `&` separators, as
 * `URLSearchParams` splits the text (ruling 51 Major 1 of the 12j lane).
 * Node's `URLSearchParams` takes time of the pairs times the length for a
 * key with no `=`: 540 759 pairs of `a&` at `SAML_FORM_MAX` took 5.2 s,
 * and a form of `=&` pairs kept 64 to 80 MB of heap. The derivation, done
 * 2026-10-30: the form route with the most fields is `POST /oauth/token`,
 * 12. The next power of two is 16. The limit is 8 times that, as for the
 * items, for the fields that a client adds and a route ignores. At this
 * limit a form of `SAML_FORM_MAX` parses in about 2 ms on Node 26.
 */
export const FORM_PAIRS_MAX = 128;

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
 * `request.body` as a stream. Null when the body was read before, such as
 * by app middleware: each reader answers it `invalid_body`, not 500
 * (ruling 46 Low 1 of the 12j lane).
 */
export async function readBodyText(
  request: Request,
  cap: number = bodyCapOfRequest(request),
): Promise<string | null> {
  if (request.bodyUsed) return null;
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

/**
 * The value of a JSON body text, or `undefined` for text that is not JSON,
 * that does not fit the shape limits, or for a body read before (null).
 */
export function parseBodyJson(text: string | null): unknown {
  if (text === null || !jsonShapeFits(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * True when the form text has at most `FORM_PAIRS_MAX` pairs. One pass over
 * the text, before `URLSearchParams`, so the parse never meets more pairs.
 */
export function formPairsFit(text: string): boolean {
  let pairs = 1;
  for (let at = text.indexOf("&"); at !== -1; at = text.indexOf("&", at + 1))
    if (++pairs > FORM_PAIRS_MAX) return false;
  return true;
}

/**
 * The pairs of a form body text, or null for text with more than
 * `FORM_PAIRS_MAX` pairs, or for a body read before (null).
 */
export function parseBodyForm(text: string | null): URLSearchParams | null {
  return text !== null && formPairsFit(text) ? new URLSearchParams(text) : null;
}
