import type { z } from "zod";
import { fail, ok, type Result } from "../result.js";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<Result<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("invalid_body");
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : fail("invalid_body");
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
