import type {
  AccountConfig,
  AccountDeleteConfirmConfig,
  AccountNoticesConfig,
  AppleConfig,
  AuthConfig,
  CaptchaConfig,
  DynamicRolesConfig,
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
  OperatorSecretEntry,
  OrganizationLimits,
  OrganizationsConfig,
  PasswordConfig,
  SecretVersion,
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
    openapi: true,
    hooks: true,
    account: true,
    captcha: true,
  } satisfies Keys<AuthConfig>,
  "secrets[]": { version: true, value: true } satisfies Keys<SecretVersion>,
  cookie: { sameSite: true } satisfies Keys<Part<"cookie">>,
  session: {
    ttlDays: true,
    slidingRefreshDays: true,
    absoluteDays: true,
    freshMinutes: true,
    deferRefresh: true,
  } satisfies Keys<Part<"session">>,
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
    roles: true,
    statements: true,
    reservedSlugs: true,
    platformOrganization: true,
    platformRole: true,
    invitationTtlDays: true,
    invitationLinkBuilder: true,
    limits: true,
    dynamicRoles: true,
  } satisfies Keys<OrganizationsConfig>,
  "organizations.dynamicRoles": {
    maxPerOrganization: true,
  } satisfies Keys<DynamicRolesConfig>,
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
    requireVerified: true,
    uniformSignUp: true,
    existingAccountMail: true,
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
    defaultResource: true,
    scopes: true,
    registration: true,
    fetch: true,
    consentPage: true,
    accessTtlMinutes: true,
    refreshTtlDays: true,
    codeTtlMinutes: true,
    introspection: true,
    dpop: true,
    signInURL: true,
    refreshReuseSeconds: true,
    device: true,
    devicePage: true,
  } satisfies Keys<OAuthConfig>,
  "oauth.device": {
    codeTtlMinutes: true,
    interval: true,
  } satisfies Keys<NonNullable<Exclude<OAuthConfig["device"], false>>>,
  "oauth.dpop": {
    algs: true,
    windowSeconds: true,
  } satisfies Keys<NonNullable<OAuthConfig["dpop"]>>,
  "oauth.registration": {
    dynamic: true,
    cimd: true,
    initialAccessTokenHash: true,
  } satisfies Keys<NonNullable<OAuthConfig["registration"]>>,
  operator: {
    secretHash: true,
    secrets: true,
    users: true,
    impersonation: true,
  } satisfies Keys<OperatorConfig>,
  "operator.secrets[]": {
    name: true,
    secretHash: true,
    scopes: true,
  } satisfies Keys<OperatorSecretEntry>,
  "operator.impersonation": {
    ttlMinutes: true,
    notice: true,
  } satisfies Keys<NonNullable<OperatorConfig["impersonation"]>>,
  hooks: {
    organization: true,
    session: true,
    user: true,
    identity: true,
    operator: true,
  } satisfies Keys<HooksConfig>,
  account: {
    mail: true,
    notices: true,
    confirmPage: true,
    delete: true,
    deleteConfirm: true,
  } satisfies Keys<AccountConfig>,
  "account.notices": { mail: true } satisfies Keys<AccountNoticesConfig>,
  "account.deleteConfirm": { ttlMinutes: true } satisfies Keys<AccountDeleteConfirmConfig>,
  captcha: { port: true, flows: true, onUnavailable: true } satisfies Keys<CaptchaConfig>,
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
