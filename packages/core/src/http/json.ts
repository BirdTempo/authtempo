import type { z } from "zod";
import { fail, ok, type Result } from "../result.js";

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
 * True when a key or a string value anywhere in a parsed body holds a NUL or
 * a lone surrogate (plan 12g fix wave, m1). The storage port refuses both in
 * a where value (rulings 16 and 17 of the 12g lane), so the body reader
 * refuses them first, and a route answers invalid_body, not 500. The walk
 * uses a stack, so a deep body cannot overflow the call stack.
 */
function holdsBadText(raw: unknown): boolean {
  const stack: unknown[] = [raw];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (value.includes("\u0000") || /\p{Cs}/u.test(value)) return true;
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) stack.push(key, item);
    }
  }
  return false;
}

export function respond<T>(result: Result<T>, headers: Record<string, string> = {}): Response {
  if (result.ok) return json(result.value, 200, headers);
  return json(
    result.message !== undefined
      ? { error: result.code, message: result.message }
      : { error: result.code },
    result.status,
    headers,
  );
}
