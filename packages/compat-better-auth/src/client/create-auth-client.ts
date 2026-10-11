import {
  type Client,
  type ClientFailure,
  type ClientResult,
  createClient,
  type InvitationJSON,
  type MemberJSON,
  type OrganizationJSON,
  type PasskeySummaryJSON,
} from "@tempo-auth/client";
import type { PublicSession } from "@tempo-auth/core";
import { createHandoff } from "@tempo-auth/handoff";
import { expoCrypto, expoOpener } from "@tempo-auth/handoff/expo";
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
  Invitation,
  Member,
  Organization,
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

const NO_BASE =
  "tempo-auth compat: this call has no baseURL and no page location. Pass baseURL to createAuthClient.";

/** Better Auth's `createAuthClient` on `@tempo-auth/client`. Nothing throws for an answer. */
export function createAuthClient(options: ClientOptions = {}): AuthClient {
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
  const expoPlugin = options.plugins?.find((p) => p.id === "expo");
  const expo: ExpoClientOptions | null =
    expoPlugin && "options" in expoPlugin ? expoPlugin.options : null;
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
      ...(options.tempoAuth?.webauthn ? { webauthn: options.tempoAuth.webauthn } : {}),
    });
    const r = await op(client);
    if (r.ok) {
      const data = map(r.value);
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
    const error = clientError(
      typeof named === "string" ? named : (code?.(r) ?? BETTER_AUTH_CODES[r.code]),
      r.status,
    );
    if (fo.onError)
      await fo.onError({
        error,
        response: last?.response ?? null,
        request: last?.request ?? { url: `${origin}${basePath}`, method: "GET" },
      });
    return { data: null, error };
  }

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
    keepToken(r.value.token);
    store.refetchIfStarted();
    return { data: { url: `${origin}${basePath}/handoff/start`, redirect: false }, error: null };
  }

  const activeOrganization = async (): Promise<string | null> =>
    (await readSession(true)).data?.session.activeOrganizationId ?? null;

  const api: AuthClient = {
    signIn: {
      async email({ email, password, rememberMe, callbackURL }) {
        // The server api refuses the same field: one rule for one argument (final review M-4).
        if (callbackURL !== undefined) return notSupported("core takes no callbackURL at sign-in");
        // Core keeps no short session. true is the only behavior core has, so it is accepted.
        if (rememberMe === false)
          return notSupported("core takes no rememberMe: every session lives session.expiresIn");
        const r = await run(
          (c) => c.password.signIn({ email, password }),
          (v) => {
            keepToken(v.token);
            return { redirect: false, token: v.token, user: toClientUser(v.user) };
          },
        );
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
    async sendVerificationEmail() {
      return notSupported("core has no resend route for the verify mail until plan 8b");
    },
    async requestPasswordReset({ email, redirectTo }) {
      const next = toNext(redirectTo, pageOrigin());
      if (next === null) return { data: null, error: compatClientError("INVALID_REDIRECT_URL") };
      return run(
        (c) => c.password.requestReset({ email, ...(next !== undefined ? { next } : {}) }),
        () => ({ status: true as const }),
      );
    },
    forgetPassword(input) {
      return api.requestPasswordReset(input);
    },
    resetPassword({ newPassword, token }) {
      return run(
        (c) => c.password.reset({ token, password: newPassword }),
        () => ({ status: true as const }),
      );
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
    useSession: store,
    getCookie() {
      const token = readStored();
      return token ? `${COOKIE_NAME}=${token}` : "";
    },
    $Infer: {} as AuthClient["$Infer"],
  };
  return api;
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
