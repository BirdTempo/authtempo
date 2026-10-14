import { OAUTH_ERRORS, type OAuthErrorCode } from "@authtempo/core/errors";
import type { OAuthResult } from "../result.js";

function isOAuthCode(code: unknown): code is OAuthErrorCode {
  return typeof code === "string" && Object.hasOwn(OAUTH_ERRORS, code);
}

/**
 * One request to a provider route. A form body goes as
 * `application/x-www-form-urlencoded` with `accept` and no other header and no
 * credentials, a CORS-safelisted request that a browser sends with no
 * preflight (plan 11d). It never throws for an answer: a rejected fetch is
 * `network`, an unreadable body is `unexpected`, and an `OAUTH_ERRORS` code
 * passes through with its status. `read` checks a 2xx body at run time and
 * answers null for a wrong shape, which is `unexpected` with the status. With
 * `bodyless`, a 2xx passes with no body read (RFC 7009 sends none).
 */
export async function oauthRequest<T>(
  doFetch: typeof fetch,
  url: string,
  input: {
    method: "GET" | "POST";
    form?: Readonly<Record<string, string>> | undefined;
    json?: unknown;
    bearer?: string | undefined;
    bodyless?: boolean | undefined;
  },
  read: (body: unknown) => T | null,
): Promise<OAuthResult<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  if (input.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(input.form).toString();
  } else if (input.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input.json);
  }
  if (input.bearer) headers.authorization = `Bearer ${input.bearer}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: input.method,
      headers,
      credentials: "omit",
      ...(body !== undefined ? { body } : {}),
    });
  } catch {
    return { ok: false, code: "network", status: 0 };
  }
  const wrong = { ok: false, code: "unexpected", status: res.status } as const;
  if (res.ok && input.bodyless) {
    const value = read(undefined);
    return value === null ? wrong : { ok: true, value };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return wrong;
  }
  if (res.ok) {
    const value = read(parsed);
    return value === null ? wrong : { ok: true, value };
  }
  const code = (parsed as { error?: unknown } | null)?.error;
  return isOAuthCode(code) ? { ok: false, code, status: res.status } : wrong;
}
