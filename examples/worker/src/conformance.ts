import type { Auth, AuthConfig } from "@authtempo/core";

/**
 * The conformance mode of the example Worker (plan 12e Task 17, rulings 51
 * to 53). Its entry is conformance-worker.ts, which only
 * wrangler.conformance.jsonc names. The deployed bundle of wrangler.jsonc
 * holds none of this file. The mode is for the local run of the OpenID
 * conformance suite release-v5.3.2 that scripts/conformance/README.md
 * describes.
 */

/** The suite's own origin (docker-compose-prebuilt.yml at release-v5.3.2, read 2026-10-20). */
export const SUITE_ORIGIN = "https://localhost.emobix.co.uk:8443";
/** The alias of this provider in each plan JSON of scripts/conformance/plans. */
export const SUITE_ALIAS = "authtempo";
/** The callback of a static client: `<server>/test/a/<alias>/callback` (run-test-plan.py, read 2026-10-20). */
export const SUITE_CALLBACK = `${SUITE_ORIGIN}/test/a/${SUITE_ALIAS}/callback`;
/** The test user that the browser steps of the plan JSON sign in with. */
export const CONFORMANCE_EMAIL = "conformance-user@example.test";
/** The two static clients of the Basic OP and Config OP plans, found again by name. */
export const CONFORMANCE_CLIENTS = [
  { name: "conformance client", authMethod: "client_secret_basic" },
  { name: "conformance client 2", authMethod: "client_secret_post" },
] as const;

/** True only for the exact value "1": any other value, or none, keeps the mode off. */
export function conformanceOn(env: { CONFORMANCE_MODE?: string }): boolean {
  return env.CONFORMANCE_MODE === "1";
}

/**
 * The fetch of `oauth.fetch` in this mode: it reaches the suite's origin
 * only, for its back-channel logout posts. Any other URL is refused before
 * a request goes out, so the mode opens no path to another host.
 */
export function suiteFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== SUITE_ORIGIN)
      return Promise.reject(new TypeError(`the conformance fetch refuses ${url.origin}`));
    return inner(input, init);
  };
}

/**
 * The config keys that the mode replaces. RS256, because OIDC Discovery 1.0
 * section 3 asks for it (plan 12e deviation 4). Dynamic registration, because
 * the two logout plans register their own clients. The default resource,
 * because the suite never sends RFC 8707 `resource` (ruling 52).
 */
export function conformanceConfig(
  baseURL: string,
  inner: typeof fetch,
): Pick<AuthConfig, "jwtMint" | "oauth"> {
  const resource = `${baseURL}/mcp`;
  return {
    jwtMint: { alg: "RS256" },
    oauth: {
      resources: [resource],
      defaultResource: resource,
      scopes: { "mcp:tools": "Use the example tools" },
      registration: { cimd: false, dynamic: true },
      device: {},
      fetch: suiteFetch(inner),
    },
  };
}

/**
 * Writes the test user and the two static clients, once per isolate, at the
 * first request. A new isolate rotates the secret of a client that exists.
 * Each secret goes to stderr once, for the plan JSON. The password comes
 * from the var CONFORMANCE_PASSWORD, never from this file.
 */
export async function seedConformance(
  auth: Auth,
  password: string,
  takeLink: () => string | null,
): Promise<void> {
  const signUp = await auth.api.password?.signUp({
    email: CONFORMANCE_EMAIL,
    password,
    ip: null,
    userAgent: null,
  });
  if (signUp && !signUp.ok) throw new Error(`the sign-up of the test user failed: ${signUp.code}`);
  // The verify link of the sign-up mail. A second sign-up of the address mails a
  // sign-in hint with no token, and its text link is no verify link.
  const link = signUp?.ok ? takeLink() : null;
  const token = link?.includes("/password/verify?token=")
    ? new URL(link).searchParams.get("token")
    : null;
  if (token) await auth.api.password?.verifyEmail({ token, ip: null, userAgent: null });
  const clients = auth.api.oauth?.clients;
  if (!clients) throw new Error("conformance mode needs oauth");
  const listed = await clients.list();
  for (const c of CONFORMANCE_CLIENTS) {
    const found = listed.ok ? listed.value.clients.find((row) => row.name === c.name) : undefined;
    const made = found
      ? await clients.rotateSecret({ clientId: found.id, keepOldHours: 0 })
      : await clients.create({
          name: c.name,
          authMethod: c.authMethod,
          redirectUris: [SUITE_CALLBACK],
          grantTypes: ["authorization_code", "refresh_token"],
        });
    if (!made.ok || !made.value.clientSecret)
      throw new Error(
        `conformance client "${c.name}" failed: ${made.ok ? "no secret" : made.error}`,
      );
    console.error(
      `conformance: ${c.name} client_id=${made.value.client.id} client_secret=${made.value.clientSecret}`,
    );
  }
}
