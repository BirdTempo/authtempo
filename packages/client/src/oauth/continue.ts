import { routeURL } from "../transport.js";

/** The short id of a held authorize request (plan 9h): `oq_` and 43 base64url characters. */
const REQUEST_ID_RE = /^oq_[A-Za-z0-9_-]{43}$/;

/**
 * The URL that an app's own sign-in route (`oauth.signInURL`, plan 12e)
 * sends the browser to after the sign-in. The URL carries the held
 * request's id alone, so the app never builds a redirect from input.
 * Throws a TypeError for an id that is not an `oq_` id.
 */
export function continueAuthorizeURL(input: {
  baseURL: string;
  basePath?: string;
  requestId: string;
}): string {
  if (!REQUEST_ID_RE.test(input.requestId))
    throw new TypeError("requestId must be the oq_ id of a held authorize request");
  return routeURL({ baseURL: input.baseURL, basePath: input.basePath }, "/oauth/authorize", {
    request_id: input.requestId,
  });
}
