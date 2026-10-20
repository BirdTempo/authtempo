import { expoClient } from "../src/client/expo.js";
import {
  adminClient,
  emailOTPClient,
  magicLinkClient,
  organizationClient,
  passkeyClient,
  twoFactorClient,
} from "../src/client/plugins.js";
import { createAuthClient } from "../src/react.js";

declare const importMetaEnv: { VITE_API_URL: string | undefined };
declare const SecureStore: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  getItemAsync(key: string): Promise<string | null>;
};
declare const bearerToken: { set(token: string): Promise<void>; get(): Promise<string | null> };

// consumer-i dashboard
export const dashboard = createAuthClient({
  baseURL: importMetaEnv.VITE_API_URL,
  basePath: "/api/auth",
  plugins: [organizationClient()],
});
export async function onboarding(
  displayName: string,
  slugify: (s: string) => string,
): Promise<string> {
  const created = await dashboard.organization.create({
    name: displayName,
    slug: slugify(displayName),
  });
  if (created.error || !created.data)
    throw new Error(created.error?.message ?? "Could not create your business");
  const orgId: string = created.data.id;
  await dashboard.organization.setActive({ organizationId: orgId });
  await dashboard.organization.inviteMember({
    email: "a@example.com",
    role: "member",
    organizationId: orgId,
  });
  return orgId;
}
export function useMe() {
  const { data, isPending, error, refetch } = dashboard.useSession();
  return {
    email: data?.user.email,
    active: data?.session.activeOrganizationId ?? null,
    isPending,
    error,
    refetch,
  };
}
export async function dashboardAuth(email: string, password: string, name: string) {
  await dashboard.signIn.email({ email, password });
  await dashboard.signUp.email({ name, email, password });
  await dashboard.signOut();
}

// consumer-i mobile
export const mobile = createAuthClient({
  baseURL: "https://api.example.com",
  basePath: "/api/auth",
  fetchOptions: {
    onSuccess: (ctx) => {
      const token = ctx.response.headers.get("set-auth-token");
      if (token) void bearerToken.set(token);
    },
  },
  plugins: [
    expoClient({ scheme: "reception", storagePrefix: "reception", storage: SecureStore }),
    organizationClient(),
  ],
});
export async function authHeaders(): Promise<{
  cookie: string | null;
  bearerToken: string | null;
}> {
  let cookie: string | null = null;
  try {
    cookie = await mobile.getCookie();
  } catch {
    // The cookie store is empty or unreadable. The bearer token still works.
  }
  return { cookie, bearerToken: await bearerToken.get() };
}

// consumere
export const web = createAuthClient();
export async function consumere(
  email: string,
  password: string,
  name: string,
  provider: "google" | "github" | "linkedin",
) {
  await web.signUp.email({ name, email, password });
  await web.signIn.email({ email, password });
  await web.signIn.social({ provider, callbackURL: "/dashboard" });
  await web.signOut();
  await web.sendVerificationEmail({ email, callbackURL: "/dashboard" });
}

// consumerc web
export const consumerc = createAuthClient({
  baseURL: "https://id.consumerc.app/api/auth",
  fetchOptions: { credentials: "include" },
  plugins: [passkeyClient(), magicLinkClient(), organizationClient()],
});
export async function consumercSignIn(email: string) {
  await consumerc.signIn.passkey();
  await consumerc.signIn.magicLink({ email, callbackURL: "/" });
  await consumerc.signIn.social({ provider: "google", callbackURL: "/" });
}

// Better Auth 1.7.2's email OTP call names (dist/plugins/email-otp/client.d.mts and the
// route paths, read 2026-10-13), as an app that posts consumerd's flows through the client calls them.
export const codes = createAuthClient({
  baseURL: "https://api.example.com/api/auth",
  plugins: [emailOTPClient(), magicLinkClient(), organizationClient()],
});
export async function codeFlows(email: string, otp: string) {
  await codes.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
  await codes.signIn.emailOtp({ email, otp });
  await codes.forgetPassword.emailOtp({ email });
  await codes.emailOtp.requestPasswordReset({ email });
  await codes.emailOtp.resetPassword({ email, otp, password: "a new correct horse" });
  await codes.forgetPassword({ email, redirectTo: "/reset" });
}

// Plan 9f: with twoFactorClient() the sign-in answer is a union; without it, it is not.
export const secured = createAuthClient({
  baseURL: "https://api.example.com",
  plugins: [twoFactorClient({ twoFactorPage: "/two-factor" })],
});
export async function securedSignIn(email: string, password: string) {
  const r = await secured.signIn.email({ email, password });
  if (r.data && "twoFactorRedirect" in r.data) {
    const methods: string[] = r.data.twoFactorMethods;
    if (!methods.includes("totp")) return undefined;
    const v = await secured.twoFactor.verifyTotp({ code: "123456", trustDevice: true });
    return v.data?.token;
  }
  return r.data?.token;
}
export async function plainSignIn(email: string, password: string) {
  const r = await dashboard.signIn.email({ email, password });
  // @ts-expect-error without twoFactorClient the answer has no twoFactorRedirect
  return r.data?.twoFactorRedirect;
}

// Plan 12f: with adminClient() the session user holds the role and the ban fields.
export const operatorConsole = createAuthClient({
  baseURL: "https://api.example.com",
  plugins: [adminClient()],
});
export async function isAdmin() {
  const r = await operatorConsole.getSession();
  const role: string | undefined = r.data?.user.role;
  const until: Date | null | undefined = r.data?.user.banExpires;
  return role === "admin" && !r.data?.user.banned && until !== undefined;
}

// Better Auth's checkRolePermission reads permissions only (plan 12k Task 10 fix).
export const canInvite: boolean = dashboard.organization.checkRolePermission({
  role: "admin",
  permissions: { invitation: ["create"] },
});
export const singular: boolean = dashboard.organization.checkRolePermission({
  role: "admin",
  // @ts-expect-error Better Auth's checkRolePermission takes no permission field
  permission: { invitation: ["create"] },
});
