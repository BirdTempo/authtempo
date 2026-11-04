import type { ClientCode } from "@authtempo/client";
import type {
  ApiTokenSummary,
  Auth,
  LimitWindow,
  OrganizationTokenSummary,
  ResolvedSession,
  Result,
  TokenQuota,
  UserRow,
} from "@authtempo/core";
import { can, type Statements } from "@authtempo/core/access";
import { createApiTokenAs, createOrganizationTokenAs } from "@authtempo/core/compat";
import {
  APIError,
  type ApiKeyCode,
  apiError,
  apiKeyError,
  BETTER_AUTH_CODES,
  compatApiError,
  RETIRED_KEY_MESSAGE,
} from "../errors.js";
import { toBetterAuthNames, toCoreNames } from "../role-map.js";
import type { ApiKey, ApiKeyOptions, ApiKeyServerApi, ApiKeyVerifyResult } from "../types.js";
import { API_KEY_DEFAULT_WINDOW, type Mapped } from "./map-options.js";

// Plan 12k Task 12: Better Auth's api-key calls on core's tokens. Every
// shape and rule below was read in @better-auth/api-key 1.7.5
// (dist/index.mjs and dist/types-y22rgFHR.d.mts) on 2026-10-21.

const DAY = 86_400;
/** Better Auth's bounds of a key life and a name (dist/index.mjs:2318 to :2349). */
const BETTER_AUTH_KEY_DEFAULTS = {
  minExpiresIn: 1,
  maxExpiresIn: 365,
  minimumNameLength: 1,
  maximumNameLength: 32,
} as const;

/** The core token kinds that a key can be. */
type Summary = ApiTokenSummary | OrganizationTokenSummary;

/**
 * Core's token as Better Auth's key. `referenceId` is the user id, or the
 * organization id of an organization token. Core's summary holds no refill
 * fields, so `extra` gives them where the call knows them.
 */
export function toApiKey(
  t: Summary,
  referenceId: string,
  extra: { refillAmount?: number | null; refillInterval?: number | null } = {},
): Omit<ApiKey, "key"> {
  return {
    id: t.id,
    configId: "default",
    name: t.name,
    start: t.hint,
    prefix: null,
    referenceId,
    refillInterval: extra.refillInterval ?? null,
    refillAmount: extra.refillAmount ?? null,
    lastRefillAt: null,
    enabled: true,
    rateLimitEnabled: t.rateLimit !== null,
    rateLimitTimeWindow: t.rateLimit === null ? null : t.rateLimit.seconds * 1000,
    rateLimitMax: t.rateLimit === null ? null : t.rateLimit.max,
    requestCount: 0,
    remaining: t.remaining,
    lastRequest: t.lastUsedAt,
    expiresAt: t.expiresAt,
    createdAt: t.createdAt,
    updatedAt: t.createdAt,
    metadata: t.metadata,
    permissions:
      t.permissions === null
        ? null
        : (toBetterAuthNames(t.permissions) as Record<string, string[]>),
  };
}

/**
 * Core's code as Better Auth's api-key code, where one fits. A member check
 * of an organization token answers `forbidden_rank` or `not_found`. Every
 * other code keeps the shim's own name.
 */
function keyFailure(r: Extract<Result<unknown>, { ok: false }>, organization: boolean): APIError {
  if (r.code === "not_found") return apiKeyError("KEY_NOT_FOUND");
  if (organization && r.code === "forbidden_rank")
    return apiKeyError("INSUFFICIENT_API_KEY_PERMISSIONS");
  if (r.message !== undefined)
    return new APIError(r.status, BETTER_AUTH_CODES[r.code as ClientCode], r.message);
  return apiError(r.code as ClientCode, r.status);
}

function unwrapKey<T>(r: Result<T>, organization: boolean): T {
  if (r.ok) return r.value;
  throw keyFailure(r, organization);
}

/** Better Auth milliseconds as core's whole seconds; any other value answers NOT_SUPPORTED (501). */
function wholeSeconds(ms: number, field: string): number {
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms % 1000 !== 0)
    throw compatApiError("NOT_SUPPORTED", `core takes ${field} in whole seconds`);
  return ms / 1000;
}

/** Better Auth seconds as core's whole days; any other value answers NOT_SUPPORTED (501). */
function wholeDays(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds % DAY !== 0)
    throw compatApiError("NOT_SUPPORTED", "core takes expiresIn in whole days");
  return seconds / DAY;
}

/** The window of a create or an update, or undefined to keep core's default. */
function windowOf(body: {
  rateLimitEnabled?: boolean;
  rateLimitTimeWindow?: number;
  rateLimitMax?: number;
}): LimitWindow | null | undefined {
  if (body.rateLimitEnabled === false) return null;
  if (body.rateLimitTimeWindow === undefined && body.rateLimitMax === undefined) return undefined;
  return {
    seconds:
      body.rateLimitTimeWindow === undefined
        ? API_KEY_DEFAULT_WINDOW.seconds
        : wholeSeconds(body.rateLimitTimeWindow, "rateLimitTimeWindow"),
    max: body.rateLimitMax ?? API_KEY_DEFAULT_WINDOW.max,
  };
}

/** The quota of a create: Better Auth's `remaining`, with its refill. Null: no quota. */
function quotaOf(body: {
  remaining?: number | null;
  refillAmount?: number;
  refillInterval?: number;
}): TokenQuota | null {
  if (body.remaining === undefined || body.remaining === null) return null;
  return {
    remaining: body.remaining,
    ...(body.refillAmount !== undefined && body.refillInterval !== undefined
      ? {
          refillAmount: body.refillAmount,
          refillSeconds: wholeSeconds(body.refillInterval, "refillInterval"),
        }
      : {}),
  };
}

/** The pair rule of a refill (dist/index.mjs:771 to :778 and :1516 to :1518). */
function refillPair(body: { refillAmount?: number; refillInterval?: number }): void {
  if (body.refillAmount !== undefined && body.refillInterval === undefined)
    throw apiKeyError("REFILL_AMOUNT_AND_INTERVAL_REQUIRED");
  if (body.refillInterval !== undefined && body.refillAmount === undefined)
    throw apiKeyError("REFILL_INTERVAL_AND_AMOUNT_REQUIRED");
}

/** Better Auth's statement names as core's set. */
const coreSet = (set: Record<string, string[]>): Statements => toCoreNames(set) as Statements;

/**
 * Better Auth's verify code of core's resolve code. A moved prefix with no
 * row answers `token_retired`: the key was revoked, skipped at the move, or
 * expired. So it answers KEY_DISABLED with a text that names each cause
 * (plan 12k Task 12).
 */
function verifyCode(code: string): { code: ApiKeyCode; message?: string } {
  if (code === "token_retired") return { code: "KEY_DISABLED", message: RETIRED_KEY_MESSAGE };
  if (code === "token_exhausted") return { code: "USAGE_EXCEEDED" };
  if (code === "rate_limited") return { code: "RATE_LIMITED" };
  return { code: "INVALID_API_KEY" };
}

function refused(code: ApiKeyCode, message?: string): ApiKeyVerifyResult {
  return { valid: false, error: { code, message: message ?? apiKeyErrorText(code) }, key: null };
}

function apiKeyErrorText(code: ApiKeyCode): string {
  return apiKeyError(code).body.message;
}

/** The api-key calls of `auth.api`, or null without the plugin. */
export function apiKeyApi(
  auth: Auth,
  mapped: Mapped,
  caller: (headers: Headers) => Promise<ResolvedSession>,
): ApiKeyServerApi | null {
  const options: ApiKeyOptions | null = mapped.apiKey;
  if (!options) return null;
  const organization = options.references === "organization";
  const storage = mapped.config.storage;
  const expiry = { ...BETTER_AUTH_KEY_DEFAULTS, ...options.keyExpiration };
  const nameMin = options.minimumNameLength ?? BETTER_AUTH_KEY_DEFAULTS.minimumNameLength;
  const nameMax = options.maximumNameLength ?? BETTER_AUTH_KEY_DEFAULTS.maximumNameLength;
  const defaultSet = options.permissions?.defaultPermissions as
    | Record<string, string[]>
    | undefined;

  /**
   * The acting user and its session: the session of `headers`, or the body's
   * `userId` of a server call, with no session.
   */
  async function actorOf(
    headers: Headers | undefined,
    userId: string | undefined,
  ): Promise<{ user: UserRow; session: ResolvedSession | null }> {
    if (headers) {
      const s = await caller(headers).catch(() => {
        throw apiKeyError("UNAUTHORIZED_SESSION");
      });
      if (userId !== undefined && userId !== s.user.id) throw apiKeyError("UNAUTHORIZED_SESSION");
      return { user: s.user, session: s };
    }
    if (userId === undefined) throw apiKeyError("UNAUTHORIZED_SESSION");
    const user = await storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);
    if (!user) throw apiKeyError("UNAUTHORIZED_SESSION");
    return { user, session: null };
  }

  /** The acting user: the session of `headers`, or the body's `userId` of a server call. */
  async function actor(headers: Headers | undefined, userId: string | undefined): Promise<UserRow> {
    return (await actorOf(headers, userId)).user;
  }

  /** The organization of an organization token by id, for the calls that take only `keyId`. */
  async function organizationOf(id: string): Promise<string> {
    const row = await storage.findOne("organizationToken", [{ field: "id", op: "eq", value: id }]);
    if (!row) throw apiKeyError("KEY_NOT_FOUND");
    return row.organizationId;
  }

  function checkName(name: string | undefined): string {
    if (name === undefined || name === "") {
      // Core keeps a name on every token, so a key with no name answers as with requireName.
      throw apiKeyError("NAME_REQUIRED");
    }
    if (name.length < nameMin || name.length > nameMax) throw apiKeyError("INVALID_NAME_LENGTH");
    return name;
  }

  function lifeOf(expiresIn: number | null | undefined): number | null {
    if (expiresIn === undefined || expiresIn === null) {
      const d = expiry.defaultExpiresIn;
      // Better Auth's default: no expiry. Core's own default of 90 days does not apply.
      return d === undefined || d === null ? null : wholeDays(d);
    }
    if (expiry.disableCustomExpiresTime === true) throw apiKeyError("KEY_DISABLED_EXPIRATION");
    const days = expiresIn / DAY;
    if (days < expiry.minExpiresIn) throw apiKeyError("EXPIRES_IN_IS_TOO_SMALL");
    if (days > expiry.maxExpiresIn) throw apiKeyError("EXPIRES_IN_IS_TOO_LARGE");
    return wholeDays(expiresIn);
  }

  return {
    async createApiKey({ body, headers }) {
      // Better Auth refuses the server-only fields on a request with headers (dist/index.mjs:734).
      if (
        headers &&
        (body.refillAmount !== undefined ||
          body.refillInterval !== undefined ||
          body.rateLimitMax !== undefined ||
          body.rateLimitTimeWindow !== undefined ||
          body.rateLimitEnabled !== undefined ||
          body.permissions !== undefined ||
          (body.remaining !== undefined && body.remaining !== null))
      )
        throw apiKeyError("SERVER_ONLY_PROPERTY");
      // A call with headers passes its session to core, so a session made before
      // the proof of its address makes no key (plan 12p). A server call names
      // its user: core's compat seam keeps the user row's rule for it.
      const { user, session } = await actorOf(headers, body.userId);
      if (body.metadata !== undefined) {
        if (options.enableMetadata !== true) throw apiKeyError("METADATA_DISABLED");
        if (typeof body.metadata !== "object" || body.metadata === null)
          throw apiKeyError("INVALID_METADATA_TYPE");
      }
      refillPair(body);
      const name = checkName(body.name);
      const expiresInDays = lifeOf(body.expiresIn);
      const set = body.permissions ?? defaultSet;
      const rateLimit = windowOf(body);
      const quota = quotaOf(body);
      const common = {
        name,
        expiresInDays,
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        ...(rateLimit !== undefined ? { rateLimit } : {}),
        ...(quota !== null ? { quota } : {}),
      };
      const extra = {
        refillAmount: quota?.refillAmount ?? null,
        refillInterval: quota?.refillSeconds === undefined ? null : quota.refillSeconds * 1000,
      };
      if (organization) {
        const organizationId = body.organizationId;
        if (organizationId === undefined) throw apiKeyError("ORGANIZATION_ID_REQUIRED");
        const fields = {
          ...common,
          organizationId,
          // An organization token holds a set; none grants nothing (deviation 4 of plan 12k).
          permissions: set === undefined ? {} : coreSet(set),
        };
        const v = unwrapKey(
          session
            ? await auth.api.organizationTokens.create({ ...fields, session })
            : await createOrganizationTokenAs(auth, { ...fields, user }),
          true,
        );
        return { ...toApiKey(v.apiToken, organizationId, extra), key: v.token };
      }
      const fields = { ...common, ...(set !== undefined ? { permissions: coreSet(set) } : {}) };
      const v = unwrapKey(
        session
          ? await auth.api.tokens.create({ ...fields, session })
          : await createApiTokenAs(auth, { ...fields, user }),
        false,
      );
      return { ...toApiKey(v.apiToken, user.id, extra), key: v.token };
    },

    async verifyApiKey({ body }) {
      // A bearer that is no token form never reaches core: a session token here is no key.
      const key = body.key;
      const tokenForm =
        key.startsWith("tk_") ||
        key.startsWith("to_") ||
        (mapped.config.tokens?.movedPrefixes ?? []).some((p) => key.startsWith(p));
      if (!tokenForm) return refused("INVALID_API_KEY");
      const r = await auth.authenticate(
        new Request(`${mapped.origin}${mapped.basePath}/api-key/verify`, {
          headers: { authorization: `Bearer ${key}` },
        }),
      );
      if (!r.ok) {
        const c = verifyCode(r.code);
        return refused(c.code, c.message);
      }
      const caller = r.value;
      let found: Omit<ApiKey, "key">;
      if (caller.kind === "token") found = toApiKey(caller.apiToken, caller.user.id);
      else if (caller.kind === "organizationToken")
        found = toApiKey(caller.apiToken, caller.organization.id);
      else return refused("INVALID_API_KEY");
      // Better Auth checks the key's own set (dist/index.mjs:1665): no set grants nothing.
      if (body.permissions !== undefined) {
        const held = caller.apiToken.permissions;
        if (held === null || !can(held, coreSet(body.permissions))) return refused("KEY_NOT_FOUND");
      }
      return { valid: true, error: null, key: found };
    },

    async getApiKey({ query, headers }) {
      const user = await actor(headers, undefined);
      if (organization) {
        const organizationId = await organizationOf(query.id);
        const list = unwrapKey(
          await auth.api.organizationTokens.list({ user, organizationId }),
          true,
        );
        const t = list.find((x) => x.id === query.id);
        if (!t) throw apiKeyError("KEY_NOT_FOUND");
        return toApiKey(t, organizationId);
      }
      const t = unwrapKey(await auth.api.tokens.list({ user }), false).find(
        (x) => x.id === query.id,
      );
      if (!t) throw apiKeyError("KEY_NOT_FOUND");
      return toApiKey(t, user.id);
    },

    async listApiKeys({ query, headers }) {
      const user = await actor(headers, undefined);
      const organizationId = query?.organizationId;
      // Better Auth lists the organization's keys with organizationId, else the user's own.
      if (organizationId !== undefined) {
        if (!organization) return [];
        return unwrapKey(
          await auth.api.organizationTokens.list({ user, organizationId }),
          true,
        ).map((t) => toApiKey(t, organizationId));
      }
      if (organization) return [];
      return unwrapKey(await auth.api.tokens.list({ user }), false).map((t) =>
        toApiKey(t, user.id),
      );
    },

    async updateApiKey({ body, headers }) {
      if (
        headers &&
        (body.refillAmount !== undefined ||
          body.refillInterval !== undefined ||
          body.rateLimitMax !== undefined ||
          body.rateLimitTimeWindow !== undefined ||
          body.rateLimitEnabled !== undefined ||
          body.remaining !== undefined ||
          body.permissions !== undefined)
      )
        throw apiKeyError("SERVER_ONLY_PROPERTY");
      if (body.enabled === false)
        throw compatApiError("NOT_SUPPORTED", "core has no disabled token; delete the key");
      if (body.metadata !== undefined)
        throw compatApiError("NOT_SUPPORTED", "core keeps the metadata of a token's create");
      refillPair(body);
      const user = await actor(headers, body.userId);
      const rateLimit = windowOf(body);
      const narrow = {
        ...(body.name !== undefined ? { name: checkName(body.name) } : {}),
        ...(body.permissions !== undefined ? { permissions: coreSet(body.permissions) } : {}),
        ...(body.expiresIn !== undefined
          ? {
              expiresAt:
                body.expiresIn === null ? null : new Date(Date.now() + body.expiresIn * 1000),
            }
          : {}),
        ...(rateLimit !== undefined ? { rateLimit } : {}),
        ...(body.remaining !== undefined
          ? {
              quota: quotaOf({
                remaining: body.remaining,
                ...(body.refillAmount !== undefined ? { refillAmount: body.refillAmount } : {}),
                ...(body.refillInterval !== undefined
                  ? { refillInterval: body.refillInterval }
                  : {}),
              }),
            }
          : {}),
      };
      if (Object.keys(narrow).length === 0) throw apiKeyError("NO_VALUES_TO_UPDATE");
      if (organization) {
        const organizationId = await organizationOf(body.keyId);
        const { permissions, ...rest } = narrow;
        const t = unwrapKey(
          await auth.api.organizationTokens.update({
            user,
            organizationId,
            id: body.keyId,
            ...rest,
            ...(permissions !== undefined ? { permissions } : {}),
          }),
          true,
        );
        return toApiKey(t, organizationId);
      }
      const t = unwrapKey(await auth.api.tokens.update({ user, id: body.keyId, ...narrow }), false);
      return toApiKey(t, user.id);
    },

    async deleteApiKey({ body, headers }) {
      const user = await actor(headers, undefined);
      if (organization) {
        const organizationId = await organizationOf(body.keyId);
        unwrapKey(
          await auth.api.organizationTokens.revoke({ user, organizationId, id: body.keyId }),
          true,
        );
      } else unwrapKey(await auth.api.tokens.revoke({ user, id: body.keyId }), false);
      return { success: true };
    },

    async deleteAllExpiredApiKeys() {
      try {
        await auth.api.sweepExpired();
        return { success: true, error: null };
      } catch (error) {
        return { success: false, error };
      }
    },
  };
}
