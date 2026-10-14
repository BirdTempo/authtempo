import type {
  AppleConfig,
  AuthConfig,
  EmailOtpConfig,
  GitHubConfig,
  GoogleConfig,
  HooksConfig,
  JwtMintConfig,
  LegacyVerifyConfig,
  LinkedInConfig,
  OAuth2Entry,
  OAuthConfig,
  OidcEndpoints,
  OidcEntry,
  OperatorConfig,
  OrganizationLimits,
  OrganizationsConfig,
  PasswordConfig,
  TotpConfig,
  TotpGateConfig,
} from "@authtempo/core";

/** One `true` for each key of T, the optional keys too. */
type Keys<T> = { readonly [K in keyof Required<T>]: true };
/** The object form of an AuthConfig field, without `undefined` and without `false`. */
type Part<K extends keyof AuthConfig> = NonNullable<Exclude<AuthConfig[K], false>>;

/**
 * Every key that `createAuth` accepts, by its path. `AuthConfig` has no
 * runtime allow list, so this list is the one source of the config page's
 * rows. Each `satisfies` ties a list to its type: a key that core adds and
 * this list lacks fails `typecheck`, and a key that this list adds and core
 * lacks fails it too (an excess property). The config check (check-config.ts)
 * then holds the page to this list. The tie reaches the object-valued keys of
 * `AuthConfig` (see `NESTED_LISTS_PRESENT` below), but not a new nested object inside a
 * nested type: a block that core adds there gets no forced list.
 */
export const CONFIG_KEYS = {
  "": {
    basePath: true,
    baseURL: true,
    secret: true,
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
    password: true,
    emailOtp: true,
    totp: true,
    jwtMint: true,
    oauth: true,
    operator: true,
    hooks: true,
  } satisfies Keys<AuthConfig>,
  cookie: { sameSite: true } satisfies Keys<Part<"cookie">>,
  session: { ttlDays: true, slidingRefreshDays: true } satisfies Keys<Part<"session">>,
  magicLink: {
    ttlMinutes: true,
    linkBuilder: true,
    confirmPage: true,
  } satisfies Keys<Part<"magicLink">>,
  social: {
    google: true,
    apple: true,
    github: true,
    linkedin: true,
    oidc: true,
    oauth2: true,
    fetch: true,
  } satisfies Keys<Part<"social">>,
  "social.google": { clientId: true, clientSecret: true } satisfies Keys<GoogleConfig>,
  "social.apple": {
    clientId: true,
    teamId: true,
    keyId: true,
    privateKey: true,
  } satisfies Keys<AppleConfig>,
  "social.github": { clientId: true, clientSecret: true } satisfies Keys<GitHubConfig>,
  "social.linkedin": { clientId: true, clientSecret: true } satisfies Keys<LinkedInConfig>,
  "social.oidc[]": {
    name: true,
    label: true,
    issuer: true,
    clientId: true,
    clientSecret: true,
    scope: true,
    endpoints: true,
  } satisfies Keys<OidcEntry>,
  "social.oidc[].endpoints": {
    authorizeUrl: true,
    tokenUrl: true,
    jwksUrl: true,
  } satisfies Keys<OidcEndpoints>,
  "social.oauth2[]": {
    name: true,
    label: true,
    authorizeUrl: true,
    tokenUrl: true,
    clientId: true,
    clientSecret: true,
    scope: true,
    authorizeParams: true,
    userinfo: true,
  } satisfies Keys<OAuth2Entry>,
  passkey: { rpID: true, rpName: true, origins: true } satisfies Keys<Part<"passkey">>,
  handoff: {
    schemes: true,
    devRedirectPattern: true,
    signInPage: true,
    confirmPage: true,
  } satisfies Keys<Part<"handoff">>,
  organizations: {
    ranks: true,
    reservedSlugs: true,
    platformOrganization: true,
    platformRole: true,
    invitationTtlDays: true,
    invitationLinkBuilder: true,
    limits: true,
  } satisfies Keys<OrganizationsConfig>,
  "organizations.limits": {
    perUser: true,
    membersPerOrganization: true,
    pendingInvitationsPerOrganization: true,
  } satisfies Keys<OrganizationLimits>,
  password: {
    hash: true,
    minLength: true,
    breachCheck: true,
    resetTtlMinutes: true,
    resetPage: true,
    legacyVerify: true,
  } satisfies Keys<PasswordConfig>,
  "password.legacyVerify": { verify: true, timeoutMs: true } satisfies Keys<LegacyVerifyConfig>,
  emailOtp: {
    ttlMinutes: true,
    length: true,
    maxAttempts: true,
    mail: true,
    resetMail: true,
  } satisfies Keys<EmailOtpConfig>,
  totp: {
    issuer: true,
    backupCodes: true,
    backupCodeLength: true,
    trustDays: true,
    trustCookieName: true,
    challengePage: true,
    gate: true,
    emailMail: true,
  } satisfies Keys<TotpConfig>,
  "totp.gate": {
    magicLink: true,
    emailOtp: true,
    social: true,
  } satisfies Keys<TotpGateConfig>,
  jwtMint: {
    alg: true,
    audience: true,
    ttlMinutes: true,
    claims: true,
    rotateEvery: true,
  } satisfies Keys<JwtMintConfig>,
  oauth: {
    resources: true,
    scopes: true,
    registration: true,
    fetch: true,
    consentPage: true,
    accessTtlMinutes: true,
    refreshTtlDays: true,
    codeTtlMinutes: true,
  } satisfies Keys<OAuthConfig>,
  "oauth.registration": {
    dynamic: true,
    cimd: true,
  } satisfies Keys<NonNullable<OAuthConfig["registration"]>>,
  operator: { secretHash: true } satisfies Keys<OperatorConfig>,
  hooks: { organization: true, session: true } satisfies Keys<HooksConfig>,
} as const;

/**
 * Every object-valued key of `AuthConfig` needs a nested list in CONFIG_KEYS.
 * A new object block in core, such as a `rateLimits` block, fails typecheck
 * here until its list exists. Block fields that this check does not count as
 * objects are named in `Flat`: they are functions, arrays, and ports.
 */
type Flat =
  | "storage"
  | "mail"
  | "limiter"
  | "clock"
  | "clientIp"
  | "trustedOrigins"
  | "jwt"
  | "webauthn";
type ObjectKeys = Exclude<
  {
    [K in keyof AuthConfig]-?: Part<K> extends
      | string
      | number
      | boolean
      | readonly unknown[]
      | ((...a: never[]) => unknown)
      ? never
      : K;
  }[keyof AuthConfig],
  Flat
>;
/** The compile-time tie: each object-valued key of AuthConfig has a nested list above. */
const NESTED_LISTS_PRESENT: ObjectKeys extends keyof typeof CONFIG_KEYS ? true : never = true;
void NESTED_LISTS_PRESENT;

/** Every key by its dotted path: `basePath`, `password.minLength`, `social.oidc[].issuer`. */
export function configKeyPaths(): string[] {
  return Object.entries(CONFIG_KEYS).flatMap(([prefix, keys]) =>
    Object.keys(keys).map((k) => (prefix === "" ? k : `${prefix}.${k}`)),
  );
}
