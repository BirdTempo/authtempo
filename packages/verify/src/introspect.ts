import type { ClientFailure } from "@authtempo/client";
import { cappedText, type FetchLike } from "./fetch.js";
import { KEY_SET_MAX_BYTES } from "./jwks.js";

/**
 * Token introspection of RFC 7662 (plan 12e, read 2026-10-20). With
 * `introspect`, the verifier asks core about each access token that passes
 * the offline check, so a revoked grant ends access at once. A token and
 * the client secret are credentials: no code here logs one.
 */

/**
 * The longest introspection answer. An answer holds the claims of one
 * token, and that token rides in one request header. The cap of the key set
 * read, 64 KiB, is far above any header that a server takes. Core's answer
 * in the tests is under 1 KiB.
 */
export const INTROSPECT_MAX_BYTES = KEY_SET_MAX_BYTES;

export interface IntrospectOptions {
  /** The id of a confidential client of the auth app with `introspect: true`. */
  clientId: string;
  /** Its secret. The verifier sends it by `client_secret_basic`. */
  clientSecret: string;
}

/** Throws for a wrong option: a fault of the app's config. */
export function checkIntrospect(input: IntrospectOptions): void {
  if (
    typeof input.clientId !== "string" ||
    input.clientId === "" ||
    typeof input.clientSecret !== "string" ||
    input.clientSecret === ""
  )
    throw new Error("authtempo verify: introspect needs a clientId and a clientSecret");
}

/** The form encoding of RFC 6749 section 2.3.1, for each part of the Basic credential. */
const formEncoded = (value: string): string =>
  new URLSearchParams({ v: value }).toString().slice(2);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True for an active token, false for `active: false`, or a failure. A
 * fetch that throws is `network`; a status other than 200 is `unexpected`
 * with that status (spec 20 item 2). A 200 whose body has no boolean
 * `active`, or is longer than `INTROSPECT_MAX_BYTES`, is `unexpected` with status 200.
 */
export async function introspectActive(
  fetch: FetchLike,
  url: string,
  client: IntrospectOptions,
  token: string,
): Promise<{ ok: true; value: boolean } | ClientFailure> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Basic ${btoa(`${formEncoded(client.clientId)}:${formEncoded(client.clientSecret)}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
    });
  } catch {
    return { ok: false, code: "network", status: 0 };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, code: "unexpected", status: res.status };
  }
  let body: unknown;
  try {
    const text = await cappedText(res, INTROSPECT_MAX_BYTES);
    if (text === null) return { ok: false, code: "unexpected", status: 200 };
    body = JSON.parse(text);
  } catch {
    return { ok: false, code: "unexpected", status: 200 };
  }
  if (!isObject(body) || typeof body.active !== "boolean")
    return { ok: false, code: "unexpected", status: 200 };
  return { ok: true, value: body.active };
}
