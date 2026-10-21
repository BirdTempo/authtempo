/**
 * The answer form of the SCIM server (RFC 7644 sections 3.1 and 3.12).
 * It lives on the engine side, so an engine module of `scim/` builds a SCIM
 * error with no read of an http module (review l2 of plan 12d Task 9b).
 * `http/routes/scim.ts` exports these names too.
 */

import type { ScimType } from "../../errors.js";

/** The media type of every SCIM answer (RFC 7644 section 3.1). */
export const SCIM_MEDIA = "application/scim+json";
export const NS_SCIM_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

/** A SCIM answer: `application/scim+json`, never cached (a list holds personal data). */
export function scimJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": SCIM_MEDIA, "cache-control": "no-store" },
  });
}

/**
 * The SCIM error message (RFC 7644 section 3.12): the Error URN, the status
 * as a string, the `scimType` when one applies, and the detail. A SCIM
 * route answers this shape and never a code of `ERRORS`. No detail holds a
 * token, a hash, or a value of the request body.
 */
export function scimError(status: number, detail: string, scimType?: ScimType): Response {
  return scimJson(
    {
      schemas: [NS_SCIM_ERROR],
      status: String(status),
      ...(scimType === undefined ? {} : { scimType }),
      detail,
    },
    status,
  );
}
