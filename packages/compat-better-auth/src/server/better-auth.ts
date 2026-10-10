import { type Auth, ConfigError, createAuth } from "@tempo-auth/core";
import { BetterAuthCompatError } from "../compat-error.js";
import { passwordPolicyCode } from "../errors.js";
import type { BetterAuthInstance, BetterAuthOptions } from "../types.js";
import { createApi } from "./api.js";
import { checkOptions } from "./check-options.js";
import { type Mapped, mapOptions } from "./map-options.js";

/** The JSON field that holds the new password, per core route (core http/routes/password.ts, read 2026-10-10). */
const PASSWORD_FIELD: Record<string, string> = {
  "/password/sign-up": "password",
  "/password/reset": "password",
  "/password/change": "newPassword",
};

/**
 * Core answers `{ "error": "password_policy" }` for every policy refusal.
 * Better Auth names the two length cases by the configured minimum, so this
 * adds `code` from the request's own password. The client reads it (Task 9),
 * so the client and `api` answer one code. `copy` is a clone of the request,
 * taken before core read the body.
 */
export async function withPolicyCode(
  copy: Request | null,
  res: Response,
  mapped: Mapped,
): Promise<Response> {
  if (!copy || res.status !== 400) return res;
  const field = PASSWORD_FIELD[new URL(copy.url).pathname.slice(mapped.basePath.length)];
  if (!field) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  if (body?.error !== "password_policy") return res;
  const sent = (await copy.json().catch(() => null)) as Record<string, unknown> | null;
  const password = typeof sent?.[field] === "string" ? (sent[field] as string) : "";
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return Response.json(
    { ...body, code: passwordPolicyCode(password, mapped.minPasswordLength) },
    { status: 400, headers },
  );
}

/** Serves core's routes under basePath. Task 8 adds the plugin behavior here. */
export function createHandler(auth: Auth, mapped: Mapped): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname !== mapped.basePath && !pathname.startsWith(`${mapped.basePath}/`)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const copy = request.method === "POST" ? request.clone() : null;
    return withPolicyCode(copy, await auth.handle(request), mapped);
  };
}

/** Better Auth's `betterAuth(options)` on tempo-auth. Throws one BetterAuthCompatError at construction (spec 16.1). */
export function betterAuth<O extends BetterAuthOptions>(options: O): BetterAuthInstance<O> {
  const check = checkOptions(options);
  if (check.refusals.length > 0) throw new BetterAuthCompatError(check.refusals);
  for (const n of check.notes) console.info(`tempo-auth compat: ${n}`);
  const mapped = mapOptions(options);
  let auth: Auth;
  try {
    auth = createAuth(mapped.config);
  } catch (e) {
    if (e instanceof ConfigError) throw new BetterAuthCompatError([`config: ${e.message}`]);
    throw e;
  }
  return {
    handler: createHandler(auth, mapped),
    api: createApi(auth, mapped),
    $Infer: {} as BetterAuthInstance<O>["$Infer"],
    options,
    tempo: auth,
  };
}
