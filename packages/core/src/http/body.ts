import type { z } from "zod";
import { fail, ok, type Result } from "../result.js";
import { readBodyText } from "./body-cap.js";
import { holdsBadText } from "./body-text.js";
import { readJson } from "./json.js";

/**
 * Reads a JSON body or a form body into one schema. A browser form posts
 * `application/x-www-form-urlencoded`; a script posts JSON. A repeated form
 * field is a client bug and fails, so a schema never sees a silent first
 * or last value. Any other content type fails `invalid_body`. Each read
 * stops at the cap of the route (rulings 43 and 46 of the 12j lane).
 */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<Result<T>> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === "application/json") return readJson(request, schema);
  if (type !== "application/x-www-form-urlencoded") return fail("invalid_body");
  const params = new URLSearchParams(await readBodyText(request));
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (key in raw) return fail("invalid_body");
    raw[key] = value;
  }
  if (holdsBadText(raw)) return fail("invalid_body");
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail("invalid_body");
}

/** True when the body is JSON. A form post and a missing type are false. */
export function isJsonRequest(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
}
