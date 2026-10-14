import {
  type Client,
  type ClientFailure,
  type ClientResult,
  createClient,
  type InvitationJSON,
  type MemberJSON,
  type OrganizationJSON,
  type PasskeySummaryJSON,
  type TwoFactorSessionJSON,
} from "@authtempo/client";
import type { PublicSession } from "@authtempo/core";
import { createHandoff } from "@authtempo/handoff";
import { expoCrypto, expoOpener } from "@authtempo/handoff/expo";
import { BETTER_AUTH_CODES, clientError, compatClientError } from "../errors.js";
import { COOKIE_NAME, toNext } from "../server/shapes.js";
import type {
  AuthClient,
  ClientOptions,
  ClientPasskey,
  ClientSession,
  ClientUser,
  CompatClientError,
  CompatClientResult,
  ExpoClientOptions,
  HasTwoFactorClient,
  Invitation,
  Member,
  Organization,
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
function toClientSession(p: PublicSession): { session: ClientSession; user: ClientUser } {
  return {
    session: {
      id: p.session.id,
      userId: p.user.id,
      expiresAt: new Date(p.session.expiresAt),
      activeOrganizationId: p.session.activeOrganizationId,
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
]);

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
  const twoFactorPlugin = options.plugins?.find(
    (p): p is Extract<typeof p, { id: "two-factor" }> => p.id === "two-factor",
  );
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
  const storageKey = expo ? `${expo.storagePrefix ?? "better-auth"}_${COOKIE_NAME}` : null;
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

  /**
   * A POST to one of the shim's Better Auth paths (plan 9f), with the same
   * fetch, headers, credentials, and Expo bearer as `run`. The shim answers
   * Better Auth's error body `{ code, message }`.
   */
  async function shim<T>(path: string, body: unknown): Promise<CompatClientResult<T>> {
    const resolved = resolveBase();
    if (!resolved) return noBase();
    const url = `${resolved.origin}${resolved.basePath}${path}`;
    const request = { url, method: "POST" };
    const headers = new Headers({ "content-type": "application/json" });
    for (const [k, v] of Object.entries(fo.headers ?? {})) headers.set(k, v);
    const stored = readStored();
    if (stored) headers.set("authorization", `Bearer ${stored}`);
    let res: Response;
    try {
      res = await baseFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        credentials: expo ? "omit" : (fo.credentials ?? "include"),
      });
    } catch {
      const error = clientError(BETTER_AUTH_CODES.network, 0);
      if (fo.onError) await fo.onError({ error, response: null, request });
      return { data: null, error };
    }
    const json = (await res
      .clone()
      .json()
      .catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && json) {
      if (fo.onSuccess) await fo.onSuccess({ data: json, response: res, request });
      return { data: json as T, error: null };
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

  const readSession = (quiet: boolean) =>
    run(
      (c) => c.session(),
      (v) => (v ? toClientSession(v) : null),
      undefined,
      quiet,
    );
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
      async social({ provider, callbackURL, disableRedirect }) {
        if (expo) return systemBrowser();
        const next = toNext(callbackURL, pageOrigin());
        if (next === null) return { data: null, error: compatClientError("INVALID_CALLBACK_URL") };
        const resolved = resolveBase();
        if (!resolved) return noBase();
        const { origin, basePath } = resolved;
        const url = `${origin}${basePath}/social/${encodeURIComponent(provider)}/start${next !== undefined ? `?next=${encodeURIComponent(next)}` : ""}`;
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
          (c) => c.password.signUp({ email, password, ...(name !== "" ? { name } : {}) }),
          (v) => {
            keepToken(v.token);
            return { token: v.token, user: toClientUser(v.user) };
          },
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
            // A member below admin cannot list invitations in core; Better Auth shows them an empty list too.
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
    },
    passkey: {
      addPasskey(input) {
        const name = input?.name;
        return run((c) => c.passkey.register(name !== undefined ? { name } : {}), passkeyOf);
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
