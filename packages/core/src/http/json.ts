import type { z } from "zod";
import { fail, ok, type Result } from "../result.js";
import { holdsBadText } from "./body-text.js";

/** The headers of every JSON answer of core. A route that writes its own JSON text reads them too. */
export const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/**
 * The error code of each JSON answer that `json` builds (plan 12h). The
 * router reads it for the `request` event. The body does not change.
 */
export const ANSWER_CODE = new WeakMap<Response, string>();

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
  if (typeof body === "object" && body !== null) {
    const code: unknown = Reflect.get(body, "error");
    if (typeof code === "string") ANSWER_CODE.set(res, code);
  }
  return res;
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<Result<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("invalid_body");
  }
  if (holdsBadText(raw)) return fail("invalid_body");
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail("invalid_body");
}

/**
 * The body of a route whose contract marks the body `optional`: an empty
 * body reads as `{}`, so a caller of the route before the body existed
 * keeps working (plan 12i). The passkey options read it.
 */
export async function readOptionalJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<Result<T>> {
  const text = await request.text();
  let raw: unknown = {};
  if (text !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      return fail("invalid_body");
    }
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail("invalid_body");
}

export function respond<T>(result: Result<T>, headers: Record<string, string> = {}): Response {
  if (result.ok) return json(result.value, 200, headers);
  const body: { error: string; message?: string; detail?: string } = { error: result.code };
  if (result.message !== undefined) body.message = result.message;
  if (result.detail !== undefined) body.detail = result.detail;
  return json(body, result.status, headers);
}
