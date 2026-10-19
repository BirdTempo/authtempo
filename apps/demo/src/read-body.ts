/*
 * The two body readers of core, as the demo needs them for one string field.
 * At the user cap the demo reads the address of a request. Core must read the
 * same address, or a body that reads two ways passes the cap. Core does not
 * export its readers, so test/node/read-body.test.ts holds these two equal to
 * core's packages/core/src/http/json.ts and http/body.ts.
 */

/** The string field `name` of a parsed body, or null. */
function fieldOf(raw: unknown, name: string): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value: unknown = Reflect.get(raw, name);
  return typeof value === "string" ? value : null;
}

/**
 * As readJson of core (http/json.ts:17): the body is JSON for every content
 * type. A body that does not parse gives null.
 */
export async function readJsonField(request: Request, name: string): Promise<string | null> {
  try {
    return fieldOf(await request.clone().json(), name);
  } catch {
    return null;
  }
}

/**
 * As readBody of core (http/body.ts:12-24): JSON only for the exact media type
 * application/json, a form only for application/x-www-form-urlencoded. Any
 * other type and a repeated form key give null.
 */
export async function readBodyField(request: Request, name: string): Promise<string | null> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === "application/json") return readJsonField(request, name);
  if (type !== "application/x-www-form-urlencoded") return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await request.clone().text());
  } catch {
    return null;
  }
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (key in raw) return null;
    raw[key] = value;
  }
  return fieldOf(raw, name);
}
