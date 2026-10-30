import { readCappedBytes } from "../primitives/read-capped.js";

/**
 * The most bytes of a request body that core reads: 8 MiB (ruling 43 of the
 * 12j lane). The cap is our own, so no platform limit holds it alone.
 *
 * The derivation, done 2026-10-30. `body-cap.test.ts` walks the body schema
 * of each route of `ROUTE_CONTRACT` and computes its largest valid body. It
 * takes each `max` of length and of items, and 3 bytes for each UTF-16 unit
 * of a string: a character that is not a control character takes at most 3
 * bytes in UTF-8. A form value takes 9 bytes for each unit (`%XX%XX%XX`).
 * A control character other than a line break or a tab takes 6 bytes as a
 * `\u` escape. The count leaves it out, because no field of a route holds
 * one in normal use.
 * The largest body is that of `POST /sso/connections/update`: 4 705 616
 * bytes. The next power of two is 8 388 608, so 3 682 992 bytes stay for
 * whitespace and for the nodes that no schema bounds. The engine holds two
 * of those nodes: `scimRoles` takes at most 100 entries (1 305 900 bytes),
 * and `metadata` takes at most 4096 bytes. With both, the largest body is
 * about 6 011 516 bytes, still under the cap. The test holds the route and
 * the count, so a schema change that moves them fails until this comment
 * and the cap move too.
 *
 * SCIM (`SCIM_BODY_MAX`) and the SAML ACS form (`SAML_FORM_MAX`) keep their
 * own smaller caps.
 */
export const REQUEST_BODY_MAX = 8_388_608;

/**
 * A request body past `REQUEST_BODY_MAX`, or a body that could not be read.
 * The router answers it 413 `body_too_large` for every route. So a route
 * that maps its own failures, such as a form post that redirects, cannot
 * hide the cap.
 */
export class BodyTooLarge extends Error {
  constructor() {
    super(`the request body is more than ${REQUEST_BODY_MAX} bytes`);
    this.name = "BodyTooLarge";
  }
}

/**
 * The request body as text, at most `REQUEST_BODY_MAX` bytes. The read is a
 * stream read that stops at the cap, so a false or absent `content-length`
 * cannot pass it. A declared length past the cap stops the read before the
 * first byte. It throws `BodyTooLarge` past the cap, on a read error, and
 * when the request aborts. The decode is that of `request.text()`: UTF-8,
 * with a replacement character for a bad byte and a leading BOM removed.
 * Workers, Node, Bun, and Deno each give `request.body` as a stream.
 */
export async function readBodyText(request: Request): Promise<string> {
  const length = request.headers.get("content-length");
  // The SCIM body read wraps the stream the same way (routes/scim.ts).
  const bytes = await readCappedBytes(
    new Response(request.body, length === null ? {} : { headers: { "content-length": length } }),
    REQUEST_BODY_MAX,
    request.signal,
  );
  if (bytes === null) throw new BodyTooLarge();
  return new TextDecoder().decode(bytes);
}
