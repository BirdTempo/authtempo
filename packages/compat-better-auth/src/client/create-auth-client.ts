import {
  type ApiTokenSummaryJSON,
  type Client,
  type ClientFailure,
  type ClientResult,
  createClient,
  type InvitationJSON,
  type MemberJSON,
  type OrganizationJSON,
  type OrganizationTokenSummaryJSON,
  type PasskeySummaryJSON,
  type RoleJSON,
  type TeamJSON,
  type TeamMemberJSON,
  type TwoFactorSessionJSON,
} from "@authtempo/client";
import { LEGACY_SESSION_COOKIE, type PublicSession } from "@authtempo/core";
import { createHandoff } from "@authtempo/handoff";
import { expoCrypto, expoOpener } from "@authtempo/handoff/expo";
import { defaultRoles, type Role } from "../access.js";
import { BETTER_AUTH_CODES, clientError, compatClientError } from "../errors.js";
import { corePermissionsOf, toBetterAuthNames, toCoreNames } from "../role-map.js";
import { ADMIN_NOT_SUPPORTED } from "../server/admin-lines.js";
import { COOKIE_NAME, toNext, toStateData } from "../server/shapes.js";
import type {
  AdminClientCalls,
  AdminListUsersQuery,
  AdminSession,
  AdminUser,
  ApiKey,
  AuthClient,
  ClientOptions,
  ClientPasskey,
  ClientSession,
  ClientSessionUser,
  ClientUser,
  CompatClientError,
  CompatClientResult,
  ExpoClientOptions,
  HasTwoFactorClient,
  Invitation,
  Member,
  Organization,
  OrganizationRoleData,
  RoleRef,
  Team,
  TeamMember,
  TwoFactorRedirect,
} from "../types.js";
import { createSessionStore } from "./session-store.js";

/** The page's origin, which core's appURL must equal for an absolute callback to keep its path. Null off the browser. */
const pageOrigin = (): string | null => (typeof location !== "undefined" ? location.origin : null);

function toClientUser(u: PublicSession["user"]): ClientUser {
  return {
    id: u.id,
    name: u.name ?? "",
    email: u.email,
    emailVerified: u.emailVerified,
    image: u.image,
  };
}
/** The JSON of the shim's `/get-session` answer: Better Auth's session with the admin fields. */
interface AdminSessionJSON {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
    activeOrganizationId: string | null;
    /** The active team (plan 12k): the server's toAdminSession holds it. */
    activeTeamId: string | null;
  };
  user: ClientUser & {
    role: string;
    banned: boolean;
    banReason: string | null;
    banExpires: string | null;
  };
  needsRefresh?: boolean;
}

/** The answer of the shim's `/get-session`, cut to the session keys and the user keys with the admin fields. */
function toAdminClientSession(p: AdminSessionJSON): {
  session: ClientSession;
  user: ClientSessionUser;
} {
  const u = p.user;
  return {
    session: {
      id: p.session.id,
      userId: p.session.userId,
      expiresAt: new Date(p.session.expiresAt),
      activeOrganizationId: p.session.activeOrganizationId,
      activeTeamId: p.session.activeTeamId,
    },
    user: {
      ...toClientUser(u),
      role: u.role,
      banned: u.banned,
      banReason: u.banReason,
      banExpires: u.banExpires === null ? null : new Date(u.banExpires),
    },
  };
}

function toClientSession(p: PublicSession): { session: ClientSession; user: ClientUser } {
  return {
    session: {
      id: p.session.id,
      userId: p.user.id,
      expiresAt: new Date(p.session.expiresAt),
      activeOrganizationId: p.session.activeOrganizationId,
      activeTeamId: p.session.activeTeamId,
    },
    user: toClientUser(p.user),
  };
}
function orgOf(o: OrganizationJSON): Organization {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    logo: null,
    metadata: o.metadata,
    createdAt: new Date(o.createdAt),
  };
}
function memberOf(organizationId: string, m: MemberJSON): Member {
  return {
    id: m.id,
    organizationId,
    userId: m.userId,
    role: m.role,
    createdAt: new Date(m.createdAt),
    user: { id: m.userId, email: m.email, name: m.name ?? "" },
  };
}
function invitationOf(i: InvitationJSON): Invitation {
  return {
    id: i.id,
    organizationId: i.organizationId,
    email: i.email,
    role: i.role,
    status: "pending",
    inviterId: i.inviterId,
    expiresAt: new Date(i.expiresAt),
    createdAt: new Date(i.createdAt),
  };
}
function passkeyOf(p: PasskeySummaryJSON): ClientPasskey {
  return {
    id: p.id,
    name: p.name,
    credentialID: p.credentialId,
    deviceType: p.deviceType,
    backedUp: p.backedUp,
    createdAt: new Date(p.createdAt),
  };
}

/** A stored role in Better Auth's shape, with Better Auth's resource names (plan 12k). */
function roleDataOf(organizationId: string, r: RoleJSON): OrganizationRoleData {
  return {
    id: r.id,
    organizationId,
    role: r.name,
    permission: toBetterAuthNames(r.permissions) as Record<string, string[]>,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}

/** A team in Better Auth's shape (plan 12k Task 11). */
function teamOf(t: TeamJSON): Team {
  return {
    id: t.id,
    name: t.name,
    organizationId: t.organizationId,
    createdAt: new Date(t.createdAt),
    updatedAt: new Date(t.updatedAt),
  };
}

/** A team member in Better Auth's shape: no address and no name (plan 12k Task 11). */
function teamMemberOf(m: TeamMemberJSON): TeamMember {
  return { id: m.id, teamId: m.teamId, userId: m.userId, createdAt: new Date(m.createdAt) };
}

/**
 * Core's token as Better Auth's key (plan 12k Task 12), as the server's
 * toApiKey builds it: `start` is core's hint, and the refill fields are null.
 */
function keyOf(
  t: ApiTokenSummaryJSON | OrganizationTokenSummaryJSON,
  referenceId: string,
): Omit<ApiKey, "key"> {
  const date = (v: string | null) => (v === null ? null : new Date(v));
  return {
    id: t.id,
    configId: "default",
    name: t.name,
    start: t.hint,
    prefix: null,
    referenceId,
    refillInterval: null,
    refillAmount: null,
    lastRefillAt: null,
    enabled: true,
    rateLimitEnabled: t.rateLimit !== null,
    rateLimitTimeWindow: t.rateLimit === null ? null : t.rateLimit.seconds * 1000,
    rateLimitMax: t.rateLimit === null ? null : t.rateLimit.max,
    requestCount: 0,
    remaining: t.remaining,
    lastRequest: date(t.lastUsedAt),
    expiresAt: date(t.expiresAt),
    createdAt: new Date(t.createdAt),
    updatedAt: new Date(t.createdAt),
    metadata: t.metadata,
    permissions:
      t.permissions === null
        ? null
        : (toBetterAuthNames(t.permissions) as Record<string, string[]>),
  };
}

/** Better Auth's api-key codes of a refused key call (@better-auth/api-key 1.7.5, read 2026-10-21). */
const keyCode = (f: ClientFailure): string | undefined =>
  f.code === "not_found"
    ? "KEY_NOT_FOUND"
    : f.code === "forbidden_rank"
      ? "INSUFFICIENT_API_KEY_PERMISSIONS"
      : undefined;

/** The server-only fields of a key create or update (dist/index.mjs:734 and :1485). */
const SERVER_ONLY_KEY_FIELDS = [
  "refillAmount",
  "refillInterval",
  "rateLimitMax",
  "rateLimitTimeWindow",
  "rateLimitEnabled",
  "remaining",
  "permissions",
  "userId",
] as const;

/** Better Auth's codes of a refused team call (dist/plugins/organization/error-codes.mjs, read 2026-10-21). */
const teamCode =
  (forbidden: string) =>
  (f: ClientFailure): string | undefined =>
    f.code === "forbidden_rank" ? forbidden : f.code === "not_found" ? "TEAM_NOT_FOUND" : undefined;

/** Better Auth's codes of a refused role call (dist/plugins/organization/error-codes.mjs, read 2026-10-21). */
const roleCode =
  (action: "CREATE" | "UPDATE" | "DELETE" | "READ" | "LIST") =>
  (f: ClientFailure): string | undefined =>
    f.code === "forbidden_rank"
      ? `YOU_ARE_NOT_ALLOWED_TO_${action}_A_ROLE`
      : f.code === "not_found"
        ? "ROLE_NOT_FOUND"
        : undefined;

/**
 * The name of a role that Better Auth names by its id: core's role calls take
 * the name. A call by `roleId` lists the roles first, so it needs `ac:read`
 * as well (README, "Access control and roles"). A call by `roleName` does not.
 */
async function roleName(
  c: Client,
  organizationId: string,
  ref: RoleRef,
): Promise<ClientResult<string>> {
  if (ref.roleName !== undefined) return { ok: true, value: ref.roleName };
  const list = await c.organizations.roles.list({ organizationId });
  if (!list.ok) return list;
  const found = list.value.find((r) => r.id === ref.roleId);
  return found ? { ok: true, value: found.name } : { ok: false, code: "not_found", status: 404 };
}

type Exact<T, K extends readonly (keyof T)[]> = [Exclude<keyof T, K[number]>] extends [never]
  ? K
  : never;
const keys =
  <T>() =>
  <const K extends readonly (keyof T)[]>(k: Exact<T, K>) =>
    k;
export const CLIENT_USER_KEYS = keys<ClientUser>()([
  "id",
  "name",
  "email",
  "emailVerified",
  "image",
]);
export const CLIENT_SESSION_KEYS = keys<ClientSession>()([
  "id",
  "userId",
  "expiresAt",
  "activeOrganizationId",
  "activeTeamId",
]);

/** The date keys of the admin answers: the user's and the session's (ruling 60 m1). */
const ADMIN_DATE_KEYS = new Set(["createdAt", "updatedAt", "banExpires", "expiresAt"]);
/** A JSON reviver that gives each date key a `Date`, as Better Auth's client parses its answers. */
function reviveDates(key: string, value: unknown): unknown {
  return ADMIN_DATE_KEYS.has(key) && typeof value === "string" ? new Date(value) : value;
}

/** The admin calls that answer NOT_SUPPORTED: every call of the type but the mapped eight. */
type AdminUnmapped = Exclude<
  keyof AdminClientCalls,
  | "listUsers"
  | "getUser"
  | "banUser"
  | "unbanUser"
  | "setRole"
  | "revokeUserSessions"
  | "impersonateUser"
  | "stopImpersonating"
  | "checkRolePermission"
>;

/** The query text of a GET admin call, with each key that has a value. */
function queryOf(query: AdminListUsersQuery | { id: string } | undefined): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : "";
}

/** Better Auth's client name of an admin path: `/admin/list-user-sessions` is `listUserSessions`. */
const adminCallName = (path: string) =>
  path.slice("/admin/".length).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const notSupported = <T>(message: string): CompatClientResult<T> => ({
  data: null,
  error: compatClientError("NOT_SUPPORTED", message),
});

/** Better Auth's baseURL may carry the path (consumerc: ".../api/auth"); it becomes basePath when basePath is absent. */
function split(options: ClientOptions): { origin: string; basePath: string } | null {
  const raw = options.baseURL ?? (typeof location !== "undefined" ? location.origin : undefined);
  if (raw === undefined) return null;
  const u = new URL(raw);
  const path = u.pathname.replace(/\/+$/, "");
  return { origin: u.origin, basePath: options.basePath ?? (path || "/api/auth") };
}

/**
 * True when the browser may go to `twoFactorPage`: a relative path, or an
 * absolute http or https URL. Better Auth 1.7.2 refuses only `javascript:`,
 * `data:`, and `vbscript:` (isSafeUrlScheme, read 2026-10-13). This rule is
 * stricter, so that a scheme that the list does not name cannot run code.
 */
function safePage(page: string): boolean {
  try {
    const { protocol } = new URL(page);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return true;
  }
}

const NO_BASE =
  "authtempo compat: this call has no baseURL and no page location. Pass baseURL to createAuthClient.";

/** Better Auth's `createAuthClient` on `@authtempo/client`. Nothing throws for an answer. */
export function createAuthClient<O extends ClientOptions = ClientOptions>(
  options: O = {} as O,
): AuthClient<HasTwoFactorClient<O>> {
  // A relative base cannot make a request URL: before plan 9b2 it rejected at the first call.
  // One error at construction names the fix. No baseURL stays legal: the first call reads
  // location (see below).
  if (options.baseURL !== undefined) {
    let absolute = false;
    try {
      const { protocol } = new URL(options.baseURL);
      absolute = protocol === "http:" || protocol === "https:";
    } catch {
      absolute = false;
    }
    if (!absolute)
      throw new Error(
        `authtempo compat: baseURL must be an absolute http or https URL, for example https://api.example.com/api/auth; got ${options.baseURL}`,
      );
  }
  // The base is resolved at the first call, not here. consumere makes its client at module
  // scope with no baseURL, and Next runs that module on the server, where there is no location.
  // A throw here would fail every page that imports the client. The first call in a browser
  // finds location. A call with neither answers an error. An answered base stays for later calls.
  let base: { origin: string; basePath: string } | null = null;
  const resolveBase = () => {
    base ??= split(options);
    return base;
  };
  const noBase = (): CompatClientResult<never> => ({
    data: null,
    error: compatClientError("BASE_URL_REQUIRED", NO_BASE),
  });
  const fo = options.fetchOptions ?? {};
  const baseFetch: typeof fetch =
    fo.customFetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const expoPlugin = options.plugins?.find(
    (p): p is Extract<typeof p, { id: "expo" }> => p.id === "expo",
  );
  const expo: ExpoClientOptions | null = expoPlugin ? expoPlugin.options : null;
  // With adminClient(), the session read goes to the shim's /get-session for the admin fields (plan 12f).
  const adminPlugin = options.plugins?.some((p) => p.id === "admin") ?? false;
  const twoFactorPlugin = options.plugins?.find(
    (p): p is Extract<typeof p, { id: "two-factor" }> => p.id === "two-factor",
  );
  const organizationPlugin = options.plugins?.find(
    (p): p is Extract<typeof p, { id: "organization" }> => p.id === "organization",
  );
  // Better Auth's client check reads its three default roles and the roles of organizationClient.
  const clientRoles: Record<string, Role> = {
    ...defaultRoles,
    ...organizationPlugin?.options?.roles,
  };
  // The challenge of the last sign-in that answered one (plan 9f). In memory only: on the web
  // the browser also keeps it as the better-auth.two_factor cookie, for a page that reloads.
  let challenge: string | null = null;
  const trustKey = expo ? `${expo.storagePrefix ?? "better-auth"}_trust_device` : null;
  const readTrust = () => {
    try {
      return expo && trustKey ? expo.storage.getItem(trustKey) || undefined : undefined;
    } catch {
      return undefined;
    }
  };
  // The key in the app's storage keeps the name of plan 9: a new key would
  // sign every Expo user out (plan 12b). getCookie() names the cookie COOKIE_NAME.
  const storageKey = expo
    ? `${expo.storagePrefix ?? "better-auth"}_${LEGACY_SESSION_COOKIE}`
    : null;
  // An unreadable store means no token: the call goes out without one.
  const readStored = () => {
    try {
      return expo && storageKey ? expo.storage.getItem(storageKey) || null : null;
    } catch {
      return null;
    }
  };
  const keepToken = (token: string) => {
    if (expo && storageKey) expo.storage.setItem(storageKey, token);
  };
  // The server answered, but the token store's setItem threw. Answer it. A rejection would reach
  // an app that awaits the call with no catch.
  const tokenStoreError = (e: unknown) =>
    clientError(
      "UNEXPECTED_RESPONSE",
      0,
      `authtempo compat: the token store failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  const dropToken = () => {
    if (expo && storageKey) expo.storage.setItem(storageKey, "");
  };

  async function run<T, V>(
    op: (c: Client) => Promise<ClientResult<T>>,
    map: (v: T) => V,
    code?: (f: ClientFailure) => string | undefined,
    quiet = false,
  ): Promise<CompatClientResult<V>> {
    const resolved = resolveBase();
    if (!resolved) return noBase();
    const { origin, basePath } = resolved;
    type Seen = { response: Response; request: { url: string; method: string } };
    let last = null as Seen | null;
    // The newest response with status 2xx. A failed sub-request of a composite call never reaches onSuccess.
    let lastOk = null as Seen | null;
    const recording: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(fo.headers ?? {})) headers.set(k, v);
      const res = await baseFetch(input, { ...init, headers });
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      last = { response: res.clone(), request: { url, method: init?.method ?? "GET" } };
      if (res.ok) lastOk = last;
      return res;
    };
    const client = createClient({
      baseURL: origin,
      basePath,
      fetch: recording,
      credentials: expo ? "omit" : (fo.credentials ?? "include"),
      ...(expo ? { token: readStored } : {}),
      ...(options.authtempo?.webauthn ? { webauthn: options.authtempo.webauthn } : {}),
    });
    const r = await op(client);
    if (r.ok) {
      let data: V;
      try {
        data = map(r.value);
      } catch (e) {
        const error = tokenStoreError(e);
        const seen = lastOk as Seen | null;
        if (fo.onError)
          await fo.onError({
            error,
            response: seen?.response ?? null,
            request: seen?.request ?? { url: `${origin}${basePath}`, method: "GET" },
          });
        return { data: null, error };
      }
      const ok = lastOk as Seen | null;
      if (fo.onSuccess && ok && !quiet)
        await fo.onSuccess({ data, response: ok.response, request: ok.request });
      return { data, error: null };
    }
    // The server's handler names the length case of a policy refusal by its minPasswordLength (withPolicyCode).
    const named =
      r.code === "password_policy" && last
        ? (
            (await last.response
              .clone()
              .json()
              .catch(() => null)) as { code?: unknown } | null
          )?.code
        : undefined;
    const errorCode = typeof named === "string" ? named : (code?.(r) ?? BETTER_AUTH_CODES[r.code]);
    // A hook refusal carries the app's own text (plan 9d). Every other code keeps the text of its name.
    const error =
      r.message !== undefined
        ? clientError(errorCode, r.status, r.message)
        : clientError(errorCode, r.status);
    if (fo.onError)
      await fo.onError({
        error,
        response: last?.response ?? null,
        request: last?.request ?? { url: `${origin}${basePath}`, method: "GET" },
      });
    return { data: null, error };
  }

  /** A request to the shim with the app's headers, the credentials of `run`, and the Expo bearer. */
  const shimFetch = (url: string, method: "GET" | "POST", body?: unknown) => {
    const headers = new Headers(method === "POST" ? { "content-type": "application/json" } : {});
    for (const [k, v] of Object.entries(fo.headers ?? {})) headers.set(k, v);
    const stored = readStored();
    if (stored) headers.set("authorization", `Bearer ${stored}`);
    return baseFetch(url, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      credentials: expo ? "omit" : (fo.credentials ?? "include"),
    });
  };

  /**
   * The session read with `adminClient()` (ruling 54 of plan 12f). It reads
   * the shim's `/get-session`, which gives the user the role and the ban
   * fields. A due session under deferSessionRefresh gets a POST there, and a
   * failed refresh keeps the GET answer, as `readSession` does with core.
   */
  async function adminSession(
    quiet: boolean,
  ): Promise<CompatClientResult<{ session: ClientSession; user: ClientSessionUser } | null>> {
    const resolved = resolveBase();
    if (!resolved) return noBase();
    const url = `${resolved.origin}${resolved.basePath}/get-session`;
    type Read = { res: Response; json: unknown; request: { url: string; method: string } };
    const read = async (method: "GET" | "POST"): Promise<Read | null> => {
      try {
        const res = await shimFetch(url, method, {});
        const json = await res
          .clone()
          .json()
          .catch(() => undefined);
        return { res, json, request: { url, method } };
      } catch {
        return null;
      }
    };
    // The shim answers 200 with null for no session, and 200 with the session.
    const answered = (x: Read | null) => x?.res.status === 200 && x.json !== undefined;
    let r = await read("GET");
    if (r && answered(r) && (r.json as AdminSessionJSON | null)?.needsRefresh === true) {
      const refreshed = await read("POST");
      if (answered(refreshed)) r = refreshed;
    }
    if (r && answered(r)) {
      const json = r.json as AdminSessionJSON | null;
      const data = json ? toAdminClientSession(json) : null;
      if (fo.onSuccess && !quiet) await fo.onSuccess({ data, response: r.res, request: r.request });
      return { data, error: null };
    }
    const body = r?.json as { code?: unknown; message?: unknown } | null | undefined;
    const code =
      r === null
        ? BETTER_AUTH_CODES.network
        : typeof body?.code === "string"
          ? body.code
          : BETTER_AUTH_CODES.unexpected;
    const error =
      typeof body?.message === "string"
        ? clientError(code, r?.res.status ?? 0, body.message)
        : clientError(code, r?.res.status ?? 0);
    if (fo.onError)
      await fo.onError({
        error,
        response: r?.res ?? null,
        request: r?.request ?? { url, method: "GET" },
      });
    return { data: null, error };
  }

  /**
   * A POST to one of the shim's Better Auth paths (plan 9f), with the same
   * fetch, headers, credentials, and Expo bearer as `run`. The shim answers
   * Better Auth's error body `{ code, message }`.
   */
  async function shim<T>(
    path: string,
    body: unknown,
    method: "GET" | "POST" = "POST",
    revive = false,
  ): Promise<CompatClientResult<T>> {
    const resolved = resolveBase();
    if (!resolved) return noBase();
    const url = `${resolved.origin}${resolved.basePath}${path}`;
    const request = { url, method };
    let res: Response;
    try {
      res = await shimFetch(url, method, body);
    } catch {
      const error = clientError(BETTER_AUTH_CODES.network, 0);
      if (fo.onError) await fo.onError({ error, response: null, request });
      return { data: null, error };
    }
    const json = (await res
      .clone()
      .text()
      .then((t) => JSON.parse(t, revive ? reviveDates : undefined))
      .catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && json) {
      if (fo.onSuccess) await fo.onSuccess({ data: json, response: res, request });
      return { data: json as T, error: null };
    }
    // Better Auth's verify-domain answers 204 with no body (plan 12d Task 14).
    if (res.status === 204) {
      if (fo.onSuccess) await fo.onSuccess({ data: null, response: res, request });
      return { data: null as T, error: null };
    }
    const code = typeof json?.code === "string" ? json.code : BETTER_AUTH_CODES.unexpected;
    const error =
      typeof json?.message === "string"
        ? clientError(code, res.status, json.message)
        : clientError(code, res.status);
    if (fo.onError) await fo.onError({ error, response: res, request });
    return { data: null, error };
  }

  /** Core's verify of the kept challenge, in Better Auth's shape. */
  const verifyChallenge = async (
    kept: string,
    input: { code?: string; backupCode?: string; trustDevice?: boolean },
  ) => {
    const r = await run(
      (c) =>
        c.totp.verify({
          challenge: kept,
          ...(input.code !== undefined ? { code: input.code } : {}),
          ...(input.backupCode !== undefined ? { backupCode: input.backupCode } : {}),
          ...(input.trustDevice !== undefined ? { trustDevice: input.trustDevice } : {}),
        }),
      (v: TwoFactorSessionJSON) => {
        keepToken(v.token);
        if (v.trustDevice && expo && trustKey) expo.storage.setItem(trustKey, v.trustDevice.token);
        challenge = null;
        return { token: v.token, user: toClientUser(v.user) };
      },
      (f) =>
        f.code === "invalid_code"
          ? input.backupCode !== undefined
            ? "INVALID_BACKUP_CODE"
            : "INVALID_CODE"
          : f.code === "too_many_attempts"
            ? "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"
            : f.code === "invalid_token"
              ? "INVALID_TWO_FACTOR_COOKIE"
              : undefined,
    );
    // A capped or dead challenge cannot answer again. Drop it, so that the next verify does not send it.
    if (
      r.error?.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" ||
      r.error?.code === "INVALID_TWO_FACTOR_COOKIE"
    )
      challenge = null;
    return r;
  };

  /** A shim verify, with the user cut to the five `ClientUser` keys: both verify branches answer one shape. */
  const shimVerify = async (
    path: string,
    body: { code: string; trustDevice?: boolean },
  ): Promise<CompatClientResult<{ token: string; user: ClientUser }>> => {
    const r = await shim<{ token: string; user: ClientUser }>(path, body);
    if (!r.data) return r;
    const { id, name, email, emailVerified, image } = r.data.user;
    return {
      data: { token: r.data.token, user: { id, name, email, emailVerified, image } },
      error: null,
    };
  };

  const coreSession = (quiet: boolean) =>
    run(
      // Under deferSessionRefresh, a due session is refreshed by a POST, as
      // Better Auth 1.7.2's session atom does (dist/client/session-atom.mjs:66
      // to :80, read 2026-10-17). A failed refresh keeps the GET answer
      // (plan 12a Task 17 review, M1).
      async (c) => {
        const r = await c.session();
        if (!r.ok || r.value?.needsRefresh !== true) return r;
        const refreshed = await c.session.refresh();
        return refreshed.ok ? refreshed : r;
      },
      (v) => (v ? toClientSession(v) : null),
      undefined,
      quiet,
    );
  const readSession = (quiet: boolean) => (adminPlugin ? adminSession(quiet) : coreSession(quiet));
  const getSession = () => readSession(false);
  const store = createSessionStore(getSession);

  async function systemBrowser(): Promise<CompatClientResult<{ url: string; redirect: boolean }>> {
    if (!expo?.webBrowser)
      return notSupported("a system-browser sign-in on Expo needs expoClient({ webBrowser })");
    const resolved = resolveBase();
    if (!resolved) return noBase();
    const { origin, basePath } = resolved;
    const handoff = createHandoff({
      baseURL: origin,
      basePath,
      redirect: `${expo.scheme}://auth`,
      opener: expoOpener(expo.webBrowser),
      ...(expo.crypto ? { crypto: expoCrypto(expo.crypto) } : {}),
      fetch: baseFetch,
    });
    const r = await handoff.signIn();
    if (!r.ok) {
      return {
        data: null,
        error: handoffError(r),
      };
    }
    try {
      keepToken(r.value.token);
    } catch (e) {
      const error = tokenStoreError(e);
      if (fo.onError)
        await fo.onError({
          error,
          response: null,
          request: { url: `${origin}${basePath}/handoff/redeem`, method: "POST" },
        });
      return { data: null, error };
    }
    store.refetchIfStarted();
    return { data: { url: `${origin}${basePath}/handoff/start`, redirect: false }, error: null };
  }

  const activeOrganization = async (): Promise<string | null> =>
    (await readSession(true)).data?.session.activeOrganizationId ?? null;

  const api: AuthClient<true> = {
    signIn: {
      async email({ email, password, rememberMe, callbackURL }) {
        // The server api refuses the same field: one rule for one argument (final review M-4).
        if (callbackURL !== undefined) return notSupported("core takes no callbackURL at sign-in");
        // Core keeps no short session. true is the only behavior core has, so it is accepted.
        if (rememberMe === false)
          return notSupported("core takes no rememberMe: every session lives session.expiresIn");
        // A session answer or a new challenge replaces the kept challenge (plan 9f). A challenge
        // that stays would go to the verify of the next user, in place of the session path.
        challenge = null;
        const trustDevice = readTrust();
        const r = await run(
          (c) => c.password.signIn({ email, password, ...(trustDevice ? { trustDevice } : {}) }),
          (v): { redirect: false; token: string; user: ClientUser } | TwoFactorRedirect => {
            // A user with the second factor on (plan 9f): keep the challenge for verifyTotp.
            if (!("token" in v)) {
              challenge = v.twoFactor.challenge;
              // The bearer of an earlier sign-in is not this sign-in's. Kept, it
              // sends a later verify to the enable path of that user (review M-6).
              dropToken();
              return { twoFactorRedirect: true, twoFactorMethods: ["totp"] };
            }
            keepToken(v.token);
            return { redirect: false, token: v.token, user: toClientUser(v.user) };
          },
        );
        if (r.data && "twoFactorRedirect" in r.data) {
          const methods = { twoFactorMethods: r.data.twoFactorMethods };
          const page = twoFactorPlugin?.options.twoFactorPage;
          if (twoFactorPlugin?.options.onTwoFactorRedirect)
            await twoFactorPlugin.options.onTwoFactorRedirect(methods);
          else if (page !== undefined && safePage(page) && typeof location !== "undefined")
            location.href = page;
          return r;
        }
        if (r.data) store.refetchIfStarted();
        return r;
      },
      async social({ provider, callbackURL, disableRedirect, additionalData }) {
        if (expo) return systemBrowser();
        const next = toNext(callbackURL, pageOrigin());
        if (next === null) return { data: null, error: compatClientError("INVALID_CALLBACK_URL") };
        // Core's sealed state payload (plan 12i Task 19). Better Auth takes a record only.
        const data = toStateData(additionalData);
        if (data === null)
          return { data: null, error: clientError(BETTER_AUTH_CODES.invalid_body, 400) };
        const resolved = resolveBase();
        if (!resolved) return noBase();
        const { origin, basePath } = resolved;
        const query = new URLSearchParams({
          ...(next !== undefined ? { next } : {}),
          ...(data !== undefined ? { data } : {}),
        }).toString();
        const url = `${origin}${basePath}/social/${encodeURIComponent(provider)}/start${query ? `?${query}` : ""}`;
        const go = disableRedirect !== true && typeof location !== "undefined";
        if (go) location.href = url;
        return { data: { url, redirect: go }, error: null };
      },
      async magicLink({ email, callbackURL, name }) {
        if (expo) {
          const r = await systemBrowser();
          return r.error ? { data: null, error: r.error } : { data: { status: true }, error: null };
        }
        if (name !== undefined) return notSupported("core takes no name at the magic link");
        const next = toNext(callbackURL, pageOrigin());
        if (next === null) return { data: null, error: compatClientError("INVALID_CALLBACK_URL") };
        return run(
          (c) => c.magicLink.request({ email, ...(next !== undefined ? { next } : {}) }),
          () => ({ status: true as const }),
        );
      },
      async passkey() {
        const r = await run((c) => c.passkey.signIn(), toClientSession);
        if (r.data) store.refetchIfStarted();
        return r;
      },
      async sso(input) {
        // The start path of the connection: the browser goes there, and core's start goes to the IdP.
        const r = await shim<{ url: string; redirect: boolean }>("/sign-in/sso", input);
        if (r.data?.redirect && typeof location !== "undefined") location.href = r.data.url;
        return r;
      },
      async emailOtp({ email, otp, name, image }) {
        if (name !== undefined || image !== undefined)
          return notSupported("core takes no name or image at the email code sign-in");
        const r = await run(
          (c) => c.emailOtp.verify({ email, code: otp }),
          (v) => {
            // The shim sets totp.gate.emailOtp false (plan 12c), as Better Auth
            // gates no email code sign-in, so core answers a session here.
            if ("twoFactor" in v)
              throw new Error(
                "authtempo compat: the email code answered a second-factor challenge",
              );
            keepToken(v.token);
            return { token: v.token, user: toClientUser(v.user) };
          },
        );
        if (r.data) store.refetchIfStarted();
        return r;
      },
    },
    signUp: {
      async email({ email, password, name, image, callbackURL }) {
        if (image !== undefined) return notSupported("core takes no image at sign-up");
        // Core's verify link lands on the app origin. The server api refuses it too.
        if (callbackURL !== undefined) return notSupported("core takes no callbackURL at sign-up");
        const r = await run(
          async (c) => {
            const up = await c.password.signUp({
              email,
              password,
              ...(name !== "" ? { name } : {}),
            });
            if (!up.ok) return up;
            // Core's uniform answer (plan 12b) carries no user, and Better
            // Auth's answer needs one. The shim's server sets uniformSignUp
            // false, so only a core server with its default answers this.
            if ("sent" in up.value) return { ok: false, code: "unexpected", status: 200 } as const;
            return { ok: true, value: up.value } as const;
          },
          (v) => {
            // The server's requireEmailVerification (plan 12b): no session, so
            // no token to keep. Better Auth answers token null.
            if (!("token" in v)) return { token: null, user: toClientUser(v.user) };
            keepToken(v.token);
            return { token: v.token, user: toClientUser(v.user) };
          },
          // The server's disableSignUp (plan 12b): Better Auth's own code, as the server api answers.
          (f) => (f.code === "sign_up_closed" ? "EMAIL_PASSWORD_SIGN_UP_DISABLED" : undefined),
        );
        if (r.data) store.refetchIfStarted();
        return r;
      },
    },
    async signOut() {
      const r = await run(
        (c) => c.signOut(),
        () => {
          dropToken();
          return { success: true as const };
        },
      );
      store.refetchIfStarted();
      return r;
    },
    getSession,
    async sendVerificationEmail({ email, callbackURL }) {
      // Core's verify link lands on the app origin. The server api refuses it too.
      if (callbackURL !== undefined)
        return notSupported("core takes no callbackURL at the verify mail");
      return run(
        (c) => c.password.resendVerification({ email }),
        () => ({ status: true as const }),
      );
    },
    async requestPasswordReset({ email, redirectTo }) {
      const next = toNext(redirectTo, pageOrigin());
      if (next === null) return { data: null, error: compatClientError("INVALID_REDIRECT_URL") };
      return run(
        (c) => c.password.requestReset({ email, ...(next !== undefined ? { next } : {}) }),
        () => ({ status: true as const }),
      );
    },
    forgetPassword: Object.assign(
      (input: { email: string; redirectTo?: string }) => api.requestPasswordReset(input),
      {
        emailOtp: ({ email }: { email: string }) => api.emailOtp.requestPasswordReset({ email }),
      },
    ),
    resetPassword({ newPassword, token }) {
      return run(
        (c) => c.password.reset({ token, password: newPassword }),
        () => ({ status: true as const }),
      );
    },
    emailOtp: {
      async sendVerificationOtp({ email, type }) {
        if (type === "sign-in")
          return run(
            (c) => c.emailOtp.request({ email }),
            () => ({ success: true as const }),
          );
        if (type === "forget-password")
          return run(
            (c) => c.emailOtp.requestReset({ email }),
            () => ({ success: true as const }),
          );
        return notSupported(
          "core serves the sign-in code and the reset code only; see the plan index",
        );
      },
      requestPasswordReset({ email }) {
        return run(
          (c) => c.emailOtp.requestReset({ email }),
          () => ({ success: true as const }),
        );
      },
      resetPassword({ email, otp, password }) {
        return run(
          (c) => c.emailOtp.reset({ email, code: otp, password }),
          () => ({ success: true as const }),
        );
      },
    },
    organization: {
      async create({ name, slug, logo, metadata }) {
        if (logo !== undefined) return notSupported("core has no organization logo");
        return run(
          (c) =>
            c.organizations.create({ slug, name, ...(metadata !== undefined ? { metadata } : {}) }),
          (v) => ({ ...orgOf(v.organization), members: [memberOf(v.organization.id, v.member)] }),
        );
      },
      list() {
        return run(
          (c) => c.organizations.list(),
          (v) => v.map((x) => orgOf(x.organization)),
        );
      },
      async setActive({ organizationId }) {
        const r = await run(
          async (c): Promise<ClientResult<OrganizationJSON | null>> => {
            const set = await c.organizations.setActive({ organizationId });
            if (!set.ok) return set;
            if (organizationId === null) return { ok: true, value: null };
            const list = await c.organizations.list();
            if (!list.ok) return list;
            return {
              ok: true,
              value:
                list.value.find((x) => x.organization.id === organizationId)?.organization ?? null,
            };
          },
          (v) => (v ? orgOf(v) : null),
        );
        store.refetchIfStarted();
        return r;
      },
      async inviteMember({ email, role, organizationId }) {
        const id = organizationId ?? (await activeOrganization());
        if (id === null) return { data: null, error: compatClientError("NO_ACTIVE_ORGANIZATION") };
        return run(
          (c) => c.organizations.invitations.invite({ organizationId: id, email, role }),
          invitationOf,
        );
      },
      acceptInvitation({ invitationId }) {
        return run(
          (c) => c.organizations.invitations.accept({ token: invitationId }),
          (v) => ({
            member: memberOf(v.organization.id, v.member),
            organization: orgOf(v.organization),
          }),
        );
      },
      async getFullOrganization(input) {
        const id = input?.organizationId ?? (await activeOrganization());
        if (id === null) return { data: null, error: null };
        return run(
          async (
            c,
          ): Promise<
            ClientResult<{
              org: OrganizationJSON;
              members: MemberJSON[];
              invitations: InvitationJSON[];
            } | null>
          > => {
            const list = await c.organizations.list();
            if (!list.ok) return list;
            const found = list.value.find((x) => x.organization.id === id);
            if (!found) return { ok: true, value: null };
            const members = await c.organizations.members.list({ organizationId: id });
            if (!members.ok) return members;
            const invitations = await c.organizations.invitations.list({ organizationId: id });
            // A role with no invitation:read cannot list the invitations in core. Better Auth shows
            // them to every member; the shim answers an empty list here.
            if (!invitations.ok && invitations.code !== "forbidden_rank") return invitations;
            return {
              ok: true,
              value: {
                org: found.organization,
                members: members.value,
                invitations: invitations.ok ? invitations.value : [],
              },
            };
          },
          (v) =>
            v
              ? {
                  ...orgOf(v.org),
                  members: v.members.map((m) => memberOf(v.org.id, m)),
                  invitations: v.invitations.map(invitationOf),
                }
              : null,
        );
      },
      // Plan 12k Task 10: Better Auth's role calls on core's dynamic roles.
      // Each write adds Better Auth's list reads, as the server's role map does.
      async createRole({ role, permission, organizationId, additionalFields }) {
        if (additionalFields !== undefined)
          return notSupported("core keeps no additional field on a role");
        const id = organizationId ?? (await activeOrganization());
        if (id === null) return { data: null, error: compatClientError("NO_ACTIVE_ORGANIZATION") };
        return run(
          (c) =>
            c.organizations.roles.create({
              organizationId: id,
              name: role,
              permissions: corePermissionsOf(permission),
            }),
          (v) => ({ success: true as const, roleData: roleDataOf(id, v), statements: permission }),
          roleCode("CREATE"),
        );
      },
      async deleteRole({ organizationId, ...ref }) {
        const id = organizationId ?? (await activeOrganization());
        if (id === null) return { data: null, error: compatClientError("NO_ACTIVE_ORGANIZATION") };
        return run(
          async (c) => {
            const name = await roleName(c, id, ref as RoleRef);
            if (!name.ok) return name;
            return c.organizations.roles.delete({ organizationId: id, name: name.value });
          },
          () => ({ success: true as const }),
          roleCode("DELETE"),
        );
      },
      async listRoles(input) {
        const id = input?.query?.organizationId ?? (await activeOrganization());
        if (id === null) return { data: null, error: compatClientError("NO_ACTIVE_ORGANIZATION") };
        return run(
          (c) => c.organizations.roles.list({ organizationId: id }),
          (v) => v.map((r) => roleDataOf(id, r)),
          roleCode("LIST"),
        );
      },
      async getRole({ query: { organizationId, ...ref } }) {
        const id = organizationId ?? (await activeOrganization());
        if (id === null) return { data: null, error: compatClientError("NO_ACTIVE_ORGANIZATION") };
        return run(
          async (c) => {
            const name = await roleName(c, id, ref as RoleRef);
            if (!name.ok) return name;
            return c.organizations.roles.get({ organizationId: id, name: name.value });
          },
          (v) => roleDataOf(id, v),
          roleCode("READ"),
        );
      },
      async updateRole({ organizationId, data, ...ref }) {
        const { permission, roleName: rename, ...extra } = data;
        if (rename !== undefined) return notSupported("core renames no role");
        if (Object.values(extra).some((v) => v !== undefined))
          return notSupported("core keeps no additional field on a role");
        const id = organizationId ?? (await activeOrganization());
        if (id === null) return { data: null, error: compatClientError("NO_ACTIVE_ORGANIZATION") };
        return run(
          async (c) => {
            const name = await roleName(c, id, ref as RoleRef);
            if (!name.ok) return name;
            return c.organizations.roles.update({
              organizationId: id,
              name: name.value,
              ...(permission !== undefined ? { permissions: corePermissionsOf(permission) } : {}),
            });
          },
          (v) => ({ success: true as const, roleData: roleDataOf(id, v) }),
          roleCode("UPDATE"),
        );
      },
      async hasPermission({ permissions, permission, organizationId, allowCreatorAllPermissions }) {
        // Core grants no right by the creator role: every right comes from the role's statements.
        if (allowCreatorAllPermissions === true)
          return notSupported("core grants the creator no permission outside its role");
        const id = organizationId ?? (await activeOrganization());
        if (id === null) return { data: null, error: compatClientError("NO_ACTIVE_ORGANIZATION") };
        return run(
          (c) =>
            c.organizations.hasPermission({
              organizationId: id,
              permissions: toCoreNames(permissions ?? permission ?? {}) as Record<string, string[]>,
            }),
          (success) => ({ error: null, success }),
        );
      },
      // Plan 12k Task 11: Better Auth's team calls on core's teams.
      async createTeam({ name, organizationId, ...extra }) {
        if (Object.values(extra).some((v) => v !== undefined))
          return notSupported("core keeps no additional field on a team");
        const id = organizationId ?? (await activeOrganization());
        if (id === null) return { data: null, error: compatClientError("NO_ACTIVE_ORGANIZATION") };
        return run(
          (c) => c.organizations.teams.create({ organizationId: id, name }),
          teamOf,
          teamCode("YOU_ARE_NOT_ALLOWED_TO_CREATE_TEAMS_IN_THIS_ORGANIZATION"),
        );
      },
      async updateTeam({ teamId, data }) {
        const { name, organizationId: _, ...extra } = data;
        if (Object.values(extra).some((v) => v !== undefined))
          return notSupported("core keeps no additional field on a team");
        return run(
          async (c): Promise<ClientResult<TeamJSON>> => {
            if (name !== undefined) return c.organizations.teams.update({ teamId, name });
            // Better Auth answers the team for an update with no field; core needs a name.
            const id = await activeOrganization();
            if (id === null) return { ok: false, code: "not_found", status: 404 };
            const list = await c.organizations.teams.list({ organizationId: id });
            if (!list.ok) return list;
            const found = list.value.find((t) => t.id === teamId);
            return found
              ? { ok: true, value: found }
              : { ok: false, code: "not_found", status: 404 };
          },
          teamOf,
          teamCode("YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_TEAM"),
        );
      },
      async removeTeam({ teamId }) {
        const r = await run(
          (c) => c.organizations.teams.delete({ teamId }),
          () => ({ message: "Team removed successfully." }),
          teamCode("YOU_ARE_NOT_ALLOWED_TO_DELETE_TEAMS_IN_THIS_ORGANIZATION"),
        );
        // Core clears the active team of each session in a deleted team.
        store.refetchIfStarted();
        return r;
      },
      async listTeams(input) {
        const id = input?.query?.organizationId ?? (await activeOrganization());
        if (id === null) return { data: null, error: compatClientError("NO_ACTIVE_ORGANIZATION") };
        return run(
          (c) => c.organizations.teams.list({ organizationId: id }),
          (v) => v.map(teamOf),
        );
      },
      async setActiveTeam(input) {
        const teamId = input?.teamId ?? null;
        const r = await run(
          async (c): Promise<ClientResult<TeamJSON | null>> => {
            const set = await c.organizations.teams.setActive({ teamId });
            if (!set.ok) return set;
            const organizationId = set.value.session.activeOrganizationId;
            if (teamId === null || organizationId === null) return { ok: true, value: null };
            const list = await c.organizations.teams.list({ organizationId });
            if (!list.ok) return list;
            return { ok: true, value: list.value.find((t) => t.id === teamId) ?? null };
          },
          (v) => (v ? teamOf(v) : null),
          teamCode("USER_IS_NOT_A_MEMBER_OF_THE_TEAM"),
        );
        store.refetchIfStarted();
        return r;
      },
      async listUserTeams(input) {
        const { userId, organizationId } = input?.query ?? {};
        return run(
          async (c): Promise<ClientResult<TeamJSON[]>> => {
            if (userId !== undefined) {
              const me = await c.session();
              if (!me.ok) return me;
              // Core lists the teams of the session's user only.
              if (me.value?.user.id !== userId)
                return { ok: false, code: "forbidden_rank", status: 403 };
            }
            const mine = await c.organizations.teams.mine();
            if (!mine.ok || organizationId === undefined) return mine;
            return {
              ok: true,
              value: mine.value.filter((t) => t.organizationId === organizationId),
            };
          },
          (v) => v.map(teamOf),
          (f) =>
            f.code === "forbidden_rank" ? "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER" : undefined,
        );
      },
      listTeamMembers(input) {
        const given = input?.query?.teamId;
        let noTeam = false;
        return run(
          async (c): Promise<ClientResult<TeamMemberJSON[]>> => {
            let teamId = given ?? null;
            if (teamId === null) {
              const me = await c.session();
              if (!me.ok) return me;
              teamId = me.value?.session.activeTeamId ?? null;
            }
            if (teamId === null) {
              noTeam = true;
              return { ok: false, code: "invalid_body", status: 400 };
            }
            return c.organizations.teams.members.list({ teamId });
          },
          (v) => v.map(teamMemberOf),
          // Better Auth's code for no team id and no active team (routes/crud-team.mjs:562).
          (f) =>
            noTeam
              ? "YOU_DO_NOT_HAVE_AN_ACTIVE_TEAM"
              : teamCode("YOU_CAN_NOT_ACCESS_THE_MEMBERS_OF_THIS_TEAM")(f),
        );
      },
      addTeamMember({ teamId, userId }) {
        let notMember = false;
        return run(
          async (c): Promise<ClientResult<TeamMemberJSON>> => {
            const r = await c.organizations.teams.members.add({ teamId, userId });
            // Core answers not_found for a missing team and for a user who is no member.
            // The team is there when the caller can list its members.
            if (!r.ok && r.code === "not_found")
              notMember = (await c.organizations.teams.members.list({ teamId })).ok;
            return r;
          },
          teamMemberOf,
          // Better Auth's code for a user who is no member (routes/crud-team.mjs:640, read 2026-10-21).
          (f) =>
            notMember
              ? "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION"
              : teamCode("YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_TEAM_MEMBER")(f),
        );
      },
      async removeTeamMember({ teamId, userId }) {
        const r = await run(
          (c) => c.organizations.teams.members.remove({ teamId, userId }),
          () => ({ message: "Team member removed successfully." }),
          teamCode("YOU_ARE_NOT_ALLOWED_TO_REMOVE_A_TEAM_MEMBER"),
        );
        store.refetchIfStarted();
        return r;
      },
      checkSlug({ slug }) {
        return run(
          async (c): Promise<ClientResult<true>> => {
            const r = await c.organizations.checkSlug({ slug });
            if (!r.ok) return r;
            // Better Auth answers { status: true } for a free slug and an error for a taken one
            // (routes/crud-org.mjs:157, read 2026-10-21).
            if (r.value.status === "available") return { ok: true, value: true };
            if (r.value.status === "invalid")
              return { ok: false, code: "invalid_body", status: 400 };
            return {
              ok: false,
              code: r.value.status === "taken" ? "slug_taken" : "slug_reserved",
              status: 409,
            };
          },
          () => ({ status: true as const }),
        );
      },
      checkRolePermission({ role, permissions }) {
        // Better Auth reads `permissions` only; with none it answers false (permission.mjs:3).
        if (!permissions) return false;
        // Better Auth's rule: one part of the role string that holds the request is enough.
        return role
          .split(",")
          .some(
            (part) =>
              Object.hasOwn(clientRoles, part) &&
              (clientRoles[part] as Role).authorize(permissions).success,
          );
      },
    },
    apiKey: {
      async create({ name, expiresIn, prefix: _prefix, metadata, organizationId, ...rest }) {
        // Better Auth refuses the server-only fields from a client (dist/index.mjs:734).
        if (SERVER_ONLY_KEY_FIELDS.some((k) => rest[k] !== undefined && rest[k] !== null))
          return { data: null, error: clientError("SERVER_ONLY_PROPERTY", 400) };
        if (name === undefined || name === "")
          return { data: null, error: clientError("NAME_REQUIRED", 400) };
        let expiresInDays: number | null = null;
        if (expiresIn !== undefined && expiresIn !== null) {
          if (!Number.isSafeInteger(expiresIn) || expiresIn % 86_400 !== 0)
            return notSupported("core takes expiresIn in whole days");
          expiresInDays = expiresIn / 86_400;
        }
        const extra = metadata !== undefined ? { metadata } : {};
        if (organizationId !== undefined)
          return run(
            (c) =>
              c.organizations.tokens.create({
                organizationId,
                name,
                // An organization token holds a set; none grants nothing (deviation 4 of plan 12k).
                permissions: {},
                expiresInDays,
                ...extra,
              }),
            (v) => ({ ...keyOf(v.apiToken, organizationId), key: v.token }),
            keyCode,
          );
        const userId = (await readSession(true)).data?.session.userId ?? "";
        return run(
          (c) => c.tokens.create({ name, expiresInDays, ...extra }),
          (v) => ({ ...keyOf(v.apiToken, userId), key: v.token }),
          keyCode,
        );
      },
      async list(input) {
        const organizationId = input?.query?.organizationId;
        if (organizationId !== undefined)
          return run(
            (c) => c.organizations.tokens.list({ organizationId }),
            (v) => v.map((t) => keyOf(t, organizationId)),
            keyCode,
          );
        const userId = (await readSession(true)).data?.session.userId ?? "";
        return run(
          (c) => c.tokens.list(),
          (v) => v.map((t) => keyOf(t, userId)),
          keyCode,
        );
      },
      async get({ query }) {
        const { id, organizationId } = query;
        const userId = (await readSession(true)).data?.session.userId ?? "";
        const owner = organizationId ?? userId;
        return run(
          async (c): Promise<ClientResult<ApiTokenSummaryJSON | OrganizationTokenSummaryJSON>> => {
            const list =
              organizationId !== undefined
                ? await c.organizations.tokens.list({ organizationId })
                : await c.tokens.list();
            if (!list.ok) return list;
            const found = (
              list.value as (ApiTokenSummaryJSON | OrganizationTokenSummaryJSON)[]
            ).find((t) => t.id === id);
            return found
              ? { ok: true, value: found }
              : { ok: false, code: "not_found", status: 404 };
          },
          (t) => keyOf(t, owner),
          keyCode,
        );
      },
      async update({ keyId, name, expiresIn, organizationId, ...rest }) {
        if (SERVER_ONLY_KEY_FIELDS.some((k) => rest[k] !== undefined))
          return { data: null, error: clientError("SERVER_ONLY_PROPERTY", 400) };
        if (rest.enabled === false)
          return notSupported("core has no disabled token; delete the key");
        if (rest.metadata !== undefined)
          return notSupported("core keeps the metadata of a token's create");
        const expiresAt =
          expiresIn === undefined
            ? {}
            : { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
        const named = name !== undefined ? { name } : {};
        if (Object.keys(named).length === 0 && expiresIn === undefined)
          return { data: null, error: clientError("NO_VALUES_TO_UPDATE", 400) };
        if (organizationId !== undefined)
          return run(
            (c) =>
              c.organizations.tokens.update({ organizationId, id: keyId, ...named, ...expiresAt }),
            (t) => keyOf(t, organizationId),
            keyCode,
          );
        const userId = (await readSession(true)).data?.session.userId ?? "";
        return run(
          (c) => c.tokens.update({ id: keyId, ...named, ...expiresAt }),
          (t) => keyOf(t, userId),
          keyCode,
        );
      },
      delete({ keyId, organizationId }) {
        return run(
          (c) =>
            organizationId !== undefined
              ? c.organizations.tokens.revoke({ organizationId, id: keyId })
              : c.tokens.revoke({ id: keyId }),
          () => ({ success: true as const }),
          keyCode,
        );
      },
    },
    passkey: {
      addPasskey(input) {
        // Better Auth 1.7.2 trims the name and keeps an empty one (@better-auth/passkey
        // dist/index.mjs:306). Core stores a blank name as none, so it goes as none.
        const name = input?.name?.trim();
        return run((c) => c.passkey.register(name ? { name } : {}), passkeyOf);
      },
      listUserPasskeys() {
        return run(
          (c) => c.passkeys.list(),
          (v) => v.map(passkeyOf),
        );
      },
      deletePasskey({ id }) {
        return run(
          (c) => c.passkeys.delete({ id }),
          () => ({ status: true as const }),
        );
      },
      updatePasskey({ id, name }) {
        return run(
          // Better Auth 1.7.2 trims the name (@better-auth/passkey dist/index.mjs:634).
          (c) => c.passkeys.rename({ id, name: name.trim() }),
          (v) => ({ passkey: passkeyOf(v) }),
          // Core answers another user's passkey as an unknown id, with no oracle.
          (f) => (f.code === "not_found" ? "PASSKEY_NOT_FOUND" : undefined),
        );
      },
    },
    twoFactor: {
      enable: (input) => shim("/two-factor/enable", input),
      disable: (input) => shim("/two-factor/disable", input),
      getTotpUri: (input) => shim("/two-factor/get-totp-uri", input),
      generateBackupCodes: (input) => shim("/two-factor/generate-backup-codes", input),
      async verifyTotp({ code, trustDevice }) {
        const kept = challenge;
        const r = kept
          ? await verifyChallenge(kept, {
              code,
              ...(trustDevice !== undefined ? { trustDevice } : {}),
            })
          : await shimVerify("/two-factor/verify-totp", {
              code,
              ...(trustDevice !== undefined ? { trustDevice } : {}),
            });
        if (r.data) store.refetchIfStarted();
        return r;
      },
      async verifyBackupCode({ code, trustDevice, disableSession }) {
        if (disableSession === true)
          return notSupported("core opens a session at every second-factor verify");
        const kept = challenge;
        const r = kept
          ? await verifyChallenge(kept, {
              backupCode: code,
              ...(trustDevice !== undefined ? { trustDevice } : {}),
            })
          : await shimVerify("/two-factor/verify-backup-code", {
              code,
              ...(trustDevice !== undefined ? { trustDevice } : {}),
            });
        if (r.data) store.refetchIfStarted();
        return r;
      },
      sendOtp: async () => notSupported("core has no email or SMS second factor"),
      verifyOtp: async () => notSupported("core has no email or SMS second factor"),
    },
    sso: {
      register: (input) => shim("/sso/register", input),
      providers: () => shim("/sso/providers", undefined, "GET"),
      getProvider: (input) =>
        shim(
          `/sso/get-provider?providerId=${encodeURIComponent(input.query.providerId)}`,
          undefined,
          "GET",
        ),
      updateProvider: (input) => shim("/sso/update-provider", input),
      deleteProvider: (input) => shim("/sso/delete-provider", input),
      requestDomainVerification: (input) => shim("/sso/request-domain-verification", input),
      verifyDomain: (input) => shim("/sso/verify-domain", input),
    },
    admin: {
      listUsers: (input) =>
        shim(`/admin/list-users${queryOf(input?.query)}`, undefined, "GET", true),
      getUser: (input) => shim(`/admin/get-user${queryOf(input.query)}`, undefined, "GET", true),
      banUser: (input) => shim("/admin/ban-user", input, "POST", true),
      unbanUser: (input) => shim("/admin/unban-user", input, "POST", true),
      setRole: (input) => shim("/admin/set-role", input, "POST", true),
      revokeUserSessions: (input) => shim("/admin/revoke-user-sessions", input),
      // Better Auth's client reads the session again after both (client.mjs atomListeners).
      async impersonateUser(input) {
        const r = await shim<{ session: AdminSession; user: AdminUser }>(
          "/admin/impersonate-user",
          input,
          "POST",
          true,
        );
        if (r.data) store.refetchIfStarted();
        return r;
      },
      async stopImpersonating() {
        const r = await shim<{ session: AdminSession | null; user: AdminUser | null }>(
          "/admin/stop-impersonating",
          {},
          "POST",
          true,
        );
        if (r.data) store.refetchIfStarted();
        return r;
      },
      // The calls core does not serve answer the handler's own lines, with no request.
      ...(Object.fromEntries(
        Object.entries(ADMIN_NOT_SUPPORTED).map(([path, { why }]) => [
          adminCallName(path),
          async () => notSupported<never>(why),
        ]),
      ) as Record<AdminUnmapped, () => Promise<CompatClientResult<never>>>),
      checkRolePermission() {
        throw new Error(
          `authtempo compat: admin.checkRolePermission: ${ADMIN_NOT_SUPPORTED["/admin/has-permission"]?.why}`,
        );
      },
    },
    useSession: store,
    getCookie() {
      const token = readStored();
      return token ? `${COOKIE_NAME}=${token}` : "";
    },
    $Infer: {} as AuthClient["$Infer"],
  };
  // The redirect answer exists only when the server gates the sign-in; the type says so per options.
  // Through unknown: TypeScript does not compare a deferred conditional type.
  return api as unknown as AuthClient<HasTwoFactorClient<O>>;
}

/**
 * The client error of a failed handoff sign-in. One status per code (plan
 * 9b): the redirect mismatch answers `INVALID_REDIRECT_URL` with the status
 * the shim's table gives it, 403, the same as the server's refusal, though
 * the app finds the mismatch with no HTTP response.
 */
export function handoffError(r: {
  code: keyof typeof BETTER_AUTH_CODES | "redirect_mismatch";
  status: number;
}): CompatClientError {
  return r.code === "redirect_mismatch"
    ? compatClientError("INVALID_REDIRECT_URL")
    : clientError(BETTER_AUTH_CODES[r.code], r.status);
}
