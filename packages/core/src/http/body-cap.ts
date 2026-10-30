import { ipKey } from "../limiter/ip-key.js";
import { readCappedOutcome } from "../primitives/read-capped.js";
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
 * more levels), a JWK may hold an array, and the `metadata` of an
 * organization or of an API token is a record of any values. That record
 * is at depth 2 of its body, so its values nest at most 14 levels: a deeper
 * value answers `invalid_body` (ruling 51 Low 5 of the 12j lane). No
 * release exists, so no stored row holds a deeper value. The test holds
 * each number.
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
 * limit a form of `SAML_FORM_MAX` in 128 pairs of long keys with no `=`
 * parses in about 2 ms on Node 26 (1.4 ms in a run of 2026-10-30). The
 * pair count does not bound each cost: one key of `+` at `SAML_FORM_MAX`
 * parses in 23 to 27 ms and peaks at 60 MB of heap, as Node turns each
 * `+` into a space (ruling 59 Low 2). The `form-plus` shape of
 * `body-memory.test.ts` bounds that heap.
 */
export const FORM_PAIRS_MAX = 128;

/**
 * The most bytes that the request reads above the floor may hold at once in
 * one isolate (ruling 51 Minor 2 of the 12j lane): the reads of
 * `BODY_CAPS`, of the SAML ACS form, and of the SCIM body. The limit of the
 * SSO writes bounds their rate, not how many run at once. A read past its
 * half of the budget answers 503 `body_busy` with `Retry-After`. A read
 * counts the bytes that it holds, so a small body at a route of a large cap
 * holds little.
 *
 * The derivation, measured 2026-10-30 (Node 26.10.0, load about 4, a
 * child with a heap of 128 MB, K reads of 8 MiB at once in chunks of 64
 * KiB: `body-memory-child.mjs budget K`). With no budget, the live heap and
 * array buffers, sampled after a GC, grew by 11 MB for K = 1, 35 MB for 4,
 * 68 MB for 8, 132 MB for 16, and 245 MB for 30. Each read in flight holds
 * about 8 MB of chunks, so a heap limit cannot see this memory. Sampled
 * with no GC, the garbage of the reads that ended counts too. A budget of 4
 * reads held the live growth at 36 MB, but its growth with garbage reached
 * 112 to 118 MB over a base of 21 MB, past the 128 MB of an isolate. A
 * budget of 2 reads holds the live growth at 20 MB, and the growth with
 * garbage at 97 MB or less for every K up to 60. So the budget is 2 reads
 * of `REQUEST_BODY_MAX`. `body-memory.test.ts` runs the budget's reads at
 * once and one more, and a burst of 30, and measures them.
 *
 * The budget is two halves that do not lend bytes to each other (ruling 66
 * Major 1 of the 12j lane): `LARGE_READ_USER_BUDGET` for the reads of
 * signed-in users, and `LARGE_READ_ANON_BUDGET` for every other read. The
 * two halves add up to the budget, and the test holds it.
 */
export const LARGE_READ_BUDGET = 2 * 8_388_608;

/**
 * The most bytes that the large reads of signed-in users hold at once in
 * one isolate: half of `LARGE_READ_BUDGET` (ruling 66 Major 1 of the 12j
 * lane). A read counts here when its client is a user (`user:<id>`), which
 * `managedCall` and `countSsoManageWrite` bind after the session check.
 * Each user may hold up to the cap of its read in this half
 * (`largeShareOf`). So the reads of any count of accounts cannot reach the
 * other half: SAML sign-in, the Apple callback, and SCIM writes keep it.
 *
 * The derivation, done 2026-10-30. Before the halves, two free accounts
 * each held 8 MiB of one SSO write for 64 s, and together they filled the
 * budget (Major 1 of rr-12j-bodycap4). Half of the budget is 8 MiB, the cap
 * of an SSO write. So this half holds one SSO write of the largest valid
 * body (4 705 616 bytes). A second such write at the same time answers 503,
 * and its client sends it again after `Retry-After`. One account that
 * stalls a write holds this half for at most 64 s (`largeReadDeadlineMs`).
 */
export const LARGE_READ_USER_BUDGET = 8_388_608;

/**
 * The most bytes that every other large read holds at once in one isolate:
 * the other half of `LARGE_READ_BUDGET` (ruling 66 Major 1 of the 12j
 * lane). A read counts here when its client is an IP (`ip:<key>`), or when
 * no bind names its client. So stalled anonymous posts cannot reach the
 * half of the users, and the SSO write of a signed-in user still reads.
 *
 * The derivation, done 2026-10-30. 8 MiB holds 7 SAML forms of
 * `SAML_FORM_MAX` (1 081 519 bytes), 32 Apple callbacks at their cap, or 8
 * SCIM bodies at once. Each of these reads ends within 10 s
 * (`largeReadDeadlineMs`). So 2 IPs that each hold `LARGE_READ_SHARE` fill
 * this half for 10 s, and must send 8 MiB each 10 s to keep it full. The
 * limits page states this residual limit.
 */
export const LARGE_READ_ANON_BUDGET = 8_388_608;

/** The seconds of `Retry-After` of `body_busy`: a large read in flight ends within about this time. */
export const BODY_BUSY_RETRY_SECONDS = 1;

/**
 * The longest time that a read above the floor waits for its next chunk
 * (ruling 59 Major 1 of the 12j lane). Past it, the read stops, frees its
 * bytes of the budget, and answers 408 `body_timeout`. Before this limit, a
 * client that sent most of a large body and stalled held its bytes of the
 * budget while its socket lived: Fastify 5.12.5 sets no request timeout,
 * and the Node http server ends a request only after 300 s.
 *
 * The derivation, done 2026-10-30. A client at `LARGE_READ_MIN_RATE` sends
 * a chunk of 64 KiB each 0.5 s. A TCP sender that loses a segment tries
 * again after 1 s, then 2 s, then 4 s (RFC 6298 sections 2.1 and 5.5: an
 * initial timeout of 1 s, which doubles at each loss). So three lost tries
 * in a row take 7 s, and 10 s keeps a margin over them.
 */
export const LARGE_READ_IDLE_MS = 10_000;

/**
 * The slowest rate, in bytes per second, at which a read above the floor
 * may arrive in all (ruling 59 Major 1 of the 12j lane). A read must end
 * within the time of its cap at this rate, and at least within
 * `LARGE_READ_DEADLINE_FLOOR_MS` (`largeReadDeadlineMs`). Past it, the read
 * stops as at the idle limit. So a client that sends a byte each few
 * seconds cannot hold its bytes of the budget for long.
 *
 * The derivation, done 2026-10-30. 128 KiB per second is 1 Mbit/s, the
 * upload rate of a slow mobile link. At this rate the largest valid SSO
 * connection write (4 705 616 bytes) takes 36 s of its 64 s, and a SAML
 * form of `SAML_FORM_MAX` (1 081 519 bytes) takes 8.3 s of its 10 s. A
 * client that is slower than this for a large body gets 408.
 */
export const LARGE_READ_MIN_RATE = 131_072;

/**
 * The least time that a read above the floor may take in all: the idle
 * limit, so a read of a small cap never ends sooner than a read that only
 * waits. The SAML form, the Apple callback, and the SCIM body each get this
 * time; an SSO connection write gets 64 s (2026-10-30).
 */
export const LARGE_READ_DEADLINE_FLOOR_MS = 10_000;

/** The time in ms that a whole read above the floor of a cap of `cap` bytes may take. */
export function largeReadDeadlineMs(cap: number): number {
  return Math.max(LARGE_READ_DEADLINE_FLOOR_MS, Math.ceil((cap * 1000) / LARGE_READ_MIN_RATE));
}

/**
 * The most bytes that the large reads of one IP hold at once (rulings 59
 * and 66 Major 1 of the 12j lane): a quarter of `LARGE_READ_BUDGET`, half
 * of `LARGE_READ_ANON_BUDGET`. A client is its IP for a read before a
 * session (`bindBodyClient`). A read past the share of its IP answers 503
 * `body_busy`, as a read past its half does. So 16 stalled posts of one IP
 * hold at most half of the anonymous half, and the other IPs keep the rest.
 * A user has no such share: it may hold the cap of its read in its half.
 * A request with no client IP has none either (ruling 66 Minor 1).
 *
 * The derivation, done 2026-10-30. 4 MiB is 3 SAML forms of
 * `SAML_FORM_MAX` (1 081 519 bytes), 16 Apple callbacks, or 4 SCIM bodies
 * from one IP at once.
 */
export const LARGE_READ_SHARE = 4_194_304;

/**
 * The bytes that `client` may hold in a read of `cap`: the cap for a user,
 * `LARGE_READ_SHARE` for an IP, and the whole anonymous half for a request
 * with no client IP, which so has no share of its own.
 */
export function largeShareOf(client: string, cap: number): number {
  if (client === UNKNOWN_CLIENT) return LARGE_READ_ANON_BUDGET;
  return isUserClient(client) ? cap : LARGE_READ_SHARE;
}

/** The client of a read before a session from `ip`: `ip:` and the key of `ipKey`, as the limiter keys an IP. */
export function ipBodyClient(ip: string | null): string {
  return `ip:${ipKey(ip)}`;
}

/**
 * The client of a request with no client IP, or with no bind: `ip:unknown`,
 * as the limiter keys it. It takes no share of its own, and its reads count
 * in the anonymous half only (ruling 66 Minor 1 of the 12j lane). On a host
 * with no `clientIp`, every request without the header is this one client.
 * With a share, 4 stalled posts of one such caller left no room to every
 * other caller with no header (Minor 1 of rr-12j-bodycap4).
 */
const UNKNOWN_CLIENT = ipBodyClient(null);

/** The start of the client of a signed-in user: `managedCall` and `countSsoManageWrite` bind `user:<id>`. */
const USER_CLIENT = "user:";

/** True when the reads of `client` count in `LARGE_READ_USER_BUDGET`, else in `LARGE_READ_ANON_BUDGET`. */
function isUserClient(client: string): boolean {
  return client.startsWith(USER_CLIENT);
}

/** The bytes that each half of the budget allows (ruling 66). */
const HALF_BUDGET = { user: LARGE_READ_USER_BUDGET, anon: LARGE_READ_ANON_BUDGET } as const;

/** The bytes that the reads above the floor of each half hold now, in this isolate. */
const heldIn = { user: 0, anon: 0 };

/** The bytes that the reads above the floor of each client hold now. An entry goes at 0. */
const heldBy = new Map<string, number>();

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

/** The client of each request, for its share of the budget. */
const CLIENT_OF = new WeakMap<Request, string>();

/**
 * Binds `request` to its client for the large reads: `ip:<key>` by the
 * router before each handler (the key of `ipKey`), and `user:<id>` after a
 * session check. The reads of a user count in `LARGE_READ_USER_BUDGET`, the
 * others in `LARGE_READ_ANON_BUDGET`. A later bind takes the place of an
 * earlier one.
 */
export function bindBodyClient(request: Request, client: string): void {
  CLIENT_OF.set(request, client);
}

/**
 * The client of `request` for its half and its share of the budget. A
 * request with no bind is `ip:unknown`, the client with no IP, whose reads
 * count in the anonymous half.
 */
export function bodyClientOf(request: Request): string {
  return CLIENT_OF.get(request) ?? UNKNOWN_CLIENT;
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
 * A read above the floor while the reads of its half of the isolate hold
 * that half (`LARGE_READ_USER_BUDGET` or `LARGE_READ_ANON_BUDGET`), or
 * while the reads of its client hold its share (`largeShareOf`). The router
 * answers it 503 `body_busy` with `Retry-After` for every route, and the
 * SCIM routes answer their own 503.
 */
export class BodyBusy extends Error {
  constructor() {
    super("the large request reads of its half of this isolate, or of its client, are full");
    this.name = "BodyBusy";
  }
}

/**
 * A read above the floor that got no chunk for `LARGE_READ_IDLE_MS`, or that
 * did not end within `largeReadDeadlineMs` of its cap. The read stopped and
 * freed its bytes of the budget. The router answers it 408 `body_timeout`
 * for every route (ruling 59 Major 1 of the 12j lane).
 */
export class BodyTimeout extends Error {
  constructor(ms: number) {
    super(`the request body did not arrive within ${ms} ms`);
    this.name = "BodyTimeout";
  }
}

/**
 * The body stream of `request`, or false when the body was read before or
 * a reader holds its lock. An app that called `getReader()` and read
 * nothing leaves `bodyUsed` false, and a `Response` of a locked stream
 * throws. The one raw read of a request body in core.
 */
function freshBody(request: Request): ReadableStream<Uint8Array> | null | false {
  const body = request.body;
  return request.bodyUsed || body?.locked === true ? false : body;
}

/**
 * True when the body of `request` was not read or locked before, so a clone
 * of it can be read. A compat package checks it before its clone.
 */
export function bodyReadable(request: Request): boolean {
  return freshBody(request) !== false;
}

/**
 * The request body as bytes, at most `cap`. The one read of a request
 * body in core: every reader of a route, the SAML ACS form, and the SCIM
 * body read through it. The read is a stream read that stops at the cap,
 * so a false or absent `content-length` cannot pass it. A declared length
 * past the cap stops the read before the first byte. It throws
 * `BodyTooLarge` past the cap, on a read error, and when the request
 * aborts. A read with a cap above the floor holds its bytes against the
 * half of `client` and against the share of `client` until it ends, and
 * throws `BodyBusy` past either one (ruling 66). It throws `BodyTimeout`
 * when it gets no chunk for `LARGE_READ_IDLE_MS`, or when it does not end
 * within `largeReadDeadlineMs` of its cap. Each end frees its bytes (ruling
 * 59 of the 12j lane). Workers, Node, Bun, and Deno each give
 * `request.body` as a stream. Null when the body was read or locked before,
 * such as by app middleware, and at a chunk that is not bytes: each reader
 * answers it `invalid_body`, not 500 (ruling 46 Low 1, ruling 51 Low 3, and
 * ruling 59 Low 1 of the 12j lane).
 */
export async function readBodyBytes(
  request: Request,
  cap: number,
  client: string = bodyClientOf(request),
): Promise<Uint8Array | null> {
  const body = freshBody(request);
  if (body === false) return null;
  const length = request.headers.get("content-length");
  const large = cap > BODY_CAP_FLOOR;
  let held = 0;
  let busy = false;
  // A read above the floor stops at its deadlines, so a stalled client frees its bytes.
  const stop = new AbortController();
  const abort = () => stop.abort();
  let timedOut = 0;
  const expire = (ms: number) => () => {
    timedOut = ms;
    stop.abort();
  };
  let idle: ReturnType<typeof setTimeout> | undefined;
  let whole: ReturnType<typeof setTimeout> | undefined;
  if (large) {
    if (request.signal.aborted) stop.abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    idle = setTimeout(expire(LARGE_READ_IDLE_MS), LARGE_READ_IDLE_MS);
    const deadline = largeReadDeadlineMs(cap);
    whole = setTimeout(expire(deadline), deadline);
  }
  const half = isUserClient(client) ? "user" : "anon";
  const share = largeShareOf(client, cap);
  const release = () => {
    if (held === 0) return;
    heldIn[half] -= held;
    const left = (heldBy.get(client) ?? 0) - held;
    if (left > 0) heldBy.set(client, left);
    else heldBy.delete(client);
    held = 0;
  };
  const take = (bytes: number) => {
    clearTimeout(idle);
    idle = setTimeout(expire(LARGE_READ_IDLE_MS), LARGE_READ_IDLE_MS);
    const mine = heldBy.get(client) ?? 0;
    if (heldIn[half] + bytes > HALF_BUDGET[half] || mine + bytes > share) {
      // Free the bytes of this read at once, so no other read in flight meets a full budget.
      release();
      busy = true;
      return false;
    }
    heldIn[half] += bytes;
    heldBy.set(client, mine + bytes);
    held += bytes;
    return true;
  };
  try {
    const read = await readCappedOutcome(
      new Response(body, length === null ? {} : { headers: { "content-length": length } }),
      cap,
      large ? stop.signal : request.signal,
      large ? take : undefined,
    );
    if (busy) throw new BodyBusy();
    if (timedOut > 0) throw new BodyTimeout(timedOut);
    // A chunk that is not bytes: a bad body, which no count saw (ruling 59 Low 1).
    if (read === "chunk") return null;
    if (!(read instanceof Uint8Array)) throw new BodyTooLarge(cap);
    return read;
  } finally {
    clearTimeout(idle);
    clearTimeout(whole);
    request.signal.removeEventListener("abort", abort);
    release();
  }
}

/**
 * The request body as text, at most `cap` bytes (the cap of the request's
 * route by default), by `readBodyBytes`, for the share of `client` (the
 * client bound to the request by default). A compat package that reads a
 * clone names the client of the request it cloned. The decode is that of
 * `request.text()`: UTF-8, with a replacement character for a bad byte and
 * a leading BOM removed. Null when the body was read before.
 */
export async function readBodyText(
  request: Request,
  cap: number = bodyCapOfRequest(request),
  client: string = bodyClientOf(request),
): Promise<string | null> {
  const bytes = await readBodyBytes(request, cap, client);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/**
 * True when the JSON text nests `[` and `{` at most `depthMax` deep and has
 * at most `itemsMax` items outside its strings: by default the limits of a
 * route body. The SCIM body passes its own item limit (`SCIM_ITEMS_MAX`,
 * ruling 56 of the 12j lane). One pass over the text, before `JSON.parse`,
 * so a body that would take more memory than its bytes never becomes
 * values. The scan does not check the grammar: `JSON.parse` does that next.
 */
export function jsonShapeFits(
  text: string,
  depthMax: number = BODY_DEPTH_MAX,
  itemsMax: number = BODY_ITEMS_MAX,
): boolean {
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
      if (depth > depthMax || items > itemsMax) return false;
    } else if (c === 0x5d || c === 0x7d) depth--;
    else if (c === 0x2c && ++items > itemsMax) return false;
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
