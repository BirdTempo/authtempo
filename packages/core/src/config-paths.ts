import type { AuthConfig } from "./config.js";

/**
 * Every top-level key of `AuthConfig`, for `GET /operator/info` (plan 11c2).
 * `AuthConfig` has no runtime allow list, so the info route lists a key only
 * when this table names it. The `satisfies` ties the table to the type: a
 * key that core adds and the table lacks fails `typecheck`, and so does a
 * key that the table adds and core lacks.
 */
export const AUTH_CONFIG_KEYS = {
  basePath: true,
  baseURL: true,
  secret: true,
  secrets: true,
  appName: true,
  trustedOrigins: true,
  appURL: true,
  cookie: true,
  storage: true,
  mail: true,
  limiter: true,
  clientIp: true,
  clock: true,
  cookieName: true,
  session: true,
  magicLink: true,
  social: true,
  jwt: true,
  passkey: true,
  webauthn: true,
  handoff: true,
  organizations: true,
  signUp: true,
  password: true,
  emailOtp: true,
  totp: true,
  jwtMint: true,
  oauth: true,
  operator: true,
  hooks: true,
  account: true,
  captcha: true,
} as const satisfies Record<keyof Required<AuthConfig>, true>;

export type AuthConfigKey = keyof typeof AUTH_CONFIG_KEYS;

/**
 * The top keys whose value is an object of options. The info route lists
 * `<key>.<sub>` under each. Never `storage`, `mail`, `limiter`, `clock`,
 * `jwt`, `webauthn`, or `clientIp`: they hold code, not options, and their
 * member names are no config.
 */
export const CONFIG_BLOCKS: ReadonlySet<AuthConfigKey> = new Set<AuthConfigKey>([
  "cookie",
  "session",
  "magicLink",
  "social",
  "passkey",
  "handoff",
  "organizations",
  "password",
  "emailOtp",
  "totp",
  "jwtMint",
  "oauth",
  "operator",
  "hooks",
  "account",
  "captcha",
]);

/** An object literal or a null-prototype object. A class instance, an array, or a port is none. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The key paths of a config, sorted: each own key of `input` that
 * `AUTH_CONFIG_KEYS` names and whose value is not `undefined`, and under a
 * key of `CONFIG_BLOCKS` whose value is a plain object, `<key>.<sub>` for
 * each own key whose value is not `undefined`. It reads no value beyond the
 * `undefined` test and the prototype test, so no secret reaches the list.
 */
export function configKeyPaths(input: AuthConfig): string[] {
  const paths: string[] = [];
  // The cast reads no member: `Object.keys` and the two tests below read the own keys only.
  const own = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(own)) {
    if (!Object.hasOwn(AUTH_CONFIG_KEYS, key)) continue;
    const value = own[key];
    if (value === undefined) continue;
    paths.push(key);
    if (!CONFIG_BLOCKS.has(key as AuthConfigKey) || !isPlainObject(value)) continue;
    for (const sub of Object.keys(value)) if (value[sub] !== undefined) paths.push(`${key}.${sub}`);
  }
  return paths.sort();
}
