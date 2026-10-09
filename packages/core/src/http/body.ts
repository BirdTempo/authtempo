import type { z } from "zod";
import { fail, ok, type Result } from "../result.js";
import { readJson } from "./json.js";

/**
 * Reads a JSON body or a form body into one schema. A browser form posts
 * `application/x-www-form-urlencoded`; a script posts JSON. A repeated form
 * field is a client bug and fails, so a schema never sees a silent first
 * or last value. Any other content type fails `invalid_body`.
 */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<Result<T>> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === "application/json") return readJson(request, schema);
  if (type !== "application/x-www-form-urlencoded") return fail("invalid_body");
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await request.text());
  } catch {
    return fail("invalid_body");
  }
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (key in raw) return fail("invalid_body");
    raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail("invalid_body");
}
