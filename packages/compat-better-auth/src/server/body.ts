import {
  BODY_BUSY_RETRY_SECONDS,
  BodyBusy,
  BodyTimeout,
  BodyTooLarge,
  bodyCapOf,
  bodyClientOf,
  bodyReadable,
  parseBodyJson,
  readBodyText,
} from "@authtempo/core/compat";
import type { RouteKey } from "@authtempo/core/routes";
import { apiError } from "../errors.js";

/**
 * The one body read of the shim (ruling 46 of the 12j lane). It reads a
 * clone of the request with core's capped reader, at the cap of the core
 * route `key` that the body goes to. With no key, it reads at core's floor:
 * every route of such a path takes the floor. Past the cap it throws core's
 * `BodyTooLarge`, and the handler answers 413 `PAYLOAD_TOO_LARGE` there, at
 * the first read. Core's depth and item limits apply before the parse.
 * The read of the clone counts on the share of the client of `request`
 * (ruling 59 of the 12j lane): the user after `countSsoManageWrite`.
 * The value, or null for a body that is not JSON.
 */
export async function readJsonOf(request: Request, key?: RouteKey): Promise<unknown> {
  // A body read or locked before cannot be cloned: it reads as no JSON, as in core (ruling 51 Low 3).
  const text = bodyReadable(request)
    ? await readBodyText(request.clone(), bodyCapOf(key), bodyClientOf(request))
    : null;
  const value = parseBodyJson(text);
  return value === undefined ? null : value;
}

/** The JSON object of a request, as `readJsonOf` reads it, or null for no object. */
export async function readObjectOf(
  request: Request,
  key?: RouteKey,
): Promise<Record<string, unknown> | null> {
  const v = await readJsonOf(request, key);
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** The answer to a body past its cap, in Better Auth's shape: 413 `PAYLOAD_TOO_LARGE`. */
export function bodyTooLarge(): Response {
  const e = apiError("body_too_large", 413);
  return Response.json(e.body, { status: e.statusCode });
}

/**
 * The answer to a large read past the budget of the isolate, in Better
 * Auth's shape: 503 `SERVICE_UNAVAILABLE`, with core's `Retry-After`
 * (ruling 51 Minor 2 of the 12j lane).
 */
export function bodyBusy(): Response {
  const e = apiError("body_busy", 503);
  return Response.json(e.body, {
    status: e.statusCode,
    headers: { "retry-after": String(BODY_BUSY_RETRY_SECONDS) },
  });
}

/**
 * The answer to a large read past its deadlines, in Better Auth's shape: 408
 * `REQUEST_TIMEOUT` (ruling 59 Major 1 of the 12j lane).
 */
export function bodyTimeout(): Response {
  const e = apiError("body_timeout", 408);
  return Response.json(e.body, { status: e.statusCode });
}

export { BodyBusy, BodyTimeout, BodyTooLarge, bodyReadable };
