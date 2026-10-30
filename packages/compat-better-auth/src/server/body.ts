import { BodyTooLarge, bodyCapOf, parseBodyJson, readBodyText } from "@authtempo/core/compat";
import type { RouteKey } from "@authtempo/core/routes";
import { apiError } from "../errors.js";

/**
 * The one body read of the shim (ruling 46 of the 12j lane). It reads a
 * clone of the request with core's capped reader, at the cap of the core
 * route `key` that the body goes to. With no key, it reads at core's floor:
 * every route of such a path takes the floor. Past the cap it throws core's
 * `BodyTooLarge`, and the handler answers 413 `PAYLOAD_TOO_LARGE` there, at
 * the first read. Core's depth and item limits apply before the parse.
 * The value, or null for a body that is not JSON.
 */
export async function readJsonOf(request: Request, key?: RouteKey): Promise<unknown> {
  const value = parseBodyJson(await readBodyText(request.clone(), bodyCapOf(key)));
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

export { BodyTooLarge };
