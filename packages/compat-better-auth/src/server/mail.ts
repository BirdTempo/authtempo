import type { AccountMailInput, MailMessage, MailPort, StorageAdapter } from "@authtempo/core";
import type {
  EmailOtpOptions,
  InvitationEmailData,
  MagicLinkOptions,
  OrganizationOptions,
  SendEmail,
} from "../types.js";
import { toInvitation, toOrganization, toUser } from "./shapes.js";

/**
 * The invitation link core builds through `invitationLinkBuilder`. It never
 * leaves this process: the port hands the token to `sendInvitationEmail`,
 * and the app builds its own link from `data.id`, as it does on Better Auth.
 */
export const INVITATION_LINK_PREFIX = "tempo-compat-invitation:";

/**
 * The marker line of an email code mail (plan 9e). It never leaves this
 * process: the port hands the code to `sendVerificationOTP`, as it hands the
 * invitation token to `sendInvitationEmail`.
 */
export const OTP_LINK_PREFIX = "tempo-compat-otp:";

/**
 * The marker of a mail that Better Auth never sends (plan 12a): the note to
 * an address that an account holds. Better Auth 1.7.2 answers
 * `{ status: true }` and mails nothing there (dist/api/routes/update-user.mjs:462
 * to :466, read 2026-10-17), so the port drops it.
 */
export const DROP_LINK_PREFIX = "tempo-compat-drop:";

/** The mail that core's `emailOtp.mail`, `emailOtp.resetMail`, and the change code answer here. */
export function otpMail(
  to: string,
  type: "sign-in" | "forget-password" | "change-email",
  code: string,
): MailMessage {
  return {
    to,
    subject: "authtempo compat email code",
    text: `\n\n${OTP_LINK_PREFIX}${type}:${code}\n\n`,
  };
}

/** Core's `account.mail` under the shim (plan 12a). Each mail carries its link on its own paragraph for the port. */
export function compatAccountMail(input: AccountMailInput): MailMessage {
  switch (input.kind) {
    case "email_change_link":
      return {
        to: input.email,
        subject: "authtempo compat change of address",
        text: `\n\n${input.link}\n\n`,
      };
    case "email_change_code":
      return otpMail(input.email, "change-email", input.code);
    case "delete_confirm":
      return {
        to: input.email,
        subject: "authtempo compat delete confirm",
        text: `\n\n${input.link}\n\n`,
      };
    case "email_change_taken":
      return {
        to: input.email,
        subject: "authtempo compat drop",
        text: `\n\n${DROP_LINK_PREFIX}\n\n`,
      };
    case "reauth_code":
      // The handler answers 404 on /reauth/email (better-auth.ts): Better Auth has no such code.
      throw new Error("authtempo compat: the shim serves no re-authentication code");
  }
}

export interface MailRoutes {
  /** The origins of the links: each entry of a `baseURL` list, or the one origin. */
  origins: readonly string[];
  basePath: string;
  storage: StorageAdapter;
  sendResetPassword?: SendEmail | undefined;
  sendVerificationEmail?: SendEmail | undefined;
  sendMagicLink?: MagicLinkOptions["sendMagicLink"] | undefined;
  sendVerificationOTP?: EmailOtpOptions["sendVerificationOTP"] | undefined;
  sendInvitationEmail?: OrganizationOptions["sendInvitationEmail"] | undefined;
  sendDeleteAccountVerification?: SendEmail | undefined;
}

/** Core writes the link on its own paragraph in every mail (engine/password.ts, magic-link.ts, invitations.ts). */
const LINK_RE = /\n\n(\S+)\n\n/;

/** The lowercase hex SHA-256 of a text: core's stored form of a token (`valueHash`, `tokenHash`). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Core's one mail port, routed to Better Auth's send callbacks by the link
 * the mail carries. A mail with no matching callback throws, and the route
 * answers 500: the option check refuses a config that lacks a callback for
 * an enabled feature, so that throw means a bug.
 */
export function compatMail(routes: MailRoutes): MailPort {
  const prefixes = routes.origins.map((o) => `${o}${routes.basePath}`);
  /** True when `link` is the core path `path` on any origin of the list. */
  const at = (link: string, path: string) => prefixes.some((p) => link.startsWith(`${p}${path}`));
  const userByEmail = async (email: string) => {
    const u = await routes.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
    return u ? toUser(u) : null;
  };
  // The verify mail follows a sign-up, so its user row exists; a missing row is a bug.
  const knownUser = async (email: string) => {
    const u = await userByEmail(email);
    if (!u) throw new Error("authtempo compat: no user for the verify mail");
    return u;
  };
  return {
    async send(message) {
      const link = LINK_RE.exec(message.text)?.[1];
      if (!link) throw new Error(`authtempo compat: the mail "${message.subject}" carries no link`);
      if (link.startsWith(INVITATION_LINK_PREFIX)) {
        const cb = routes.sendInvitationEmail;
        if (!cb) throw new Error("authtempo compat: no sendInvitationEmail");
        const token = link.slice(INVITATION_LINK_PREFIX.length);
        const row = await routes.storage.findOne("invitation", [
          { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
        ]);
        if (!row) throw new Error("authtempo compat: the invitation of this mail is gone");
        const org = await routes.storage.findOne("organization", [
          { field: "id", op: "eq", value: row.organizationId },
        ]);
        const inviter = await routes.storage.findOne("user", [
          { field: "id", op: "eq", value: row.inviterId },
        ]);
        if (!org || !inviter)
          throw new Error(
            "authtempo compat: the organization or the inviter of this invitation is gone",
          );
        const invitation = toInvitation(row, token, "pending");
        const data: InvitationEmailData = {
          id: token,
          role: row.role,
          email: row.email,
          organization: toOrganization(org),
          inviter: { user: toUser(inviter) },
          invitation,
        };
        await cb(data);
        return;
      }
      if (link.startsWith(OTP_LINK_PREFIX)) {
        const cb = routes.sendVerificationOTP;
        if (!cb) throw new Error("authtempo compat: no sendVerificationOTP");
        const [type, otp] = link.slice(OTP_LINK_PREFIX.length).split(":");
        if ((type !== "sign-in" && type !== "forget-password" && type !== "change-email") || !otp)
          throw new Error("authtempo compat: the email code mail is malformed");
        // Better Auth sends a reset code only to an address with a user
        // (routes.mjs requestPasswordResetEmailOTP, read 2026-10-13). Send
        // nothing and do not throw: a throw answers 500, and that difference
        // is the tell.
        if (type === "forget-password" && !(await userByEmail(message.to))) return;
        await cb({ email: message.to, otp, type });
        return;
      }
      if (link.startsWith(DROP_LINK_PREFIX)) return;
      const token = new URL(link).searchParams.get("token") ?? "";
      if (at(link, "/password/verify?")) {
        if (!routes.sendVerificationEmail)
          throw new Error("authtempo compat: no sendVerificationEmail");
        await routes.sendVerificationEmail({
          user: await knownUser(message.to),
          url: link,
          token,
        });
        return;
      }
      if (at(link, "/password/reset?")) {
        if (!routes.sendResetPassword) throw new Error("authtempo compat: no sendResetPassword");
        // Core mails a reset link to every address and answers 200 for each,
        // so the answer tells no one which address has an account. With no
        // user row, send nothing and do not throw: a throw answers 500, and
        // that difference is the tell. Better Auth also sends nothing here.
        const user = await userByEmail(message.to);
        if (!user) return;
        await routes.sendResetPassword({ user, url: link, token });
        return;
      }
      if (at(link, "/magic-link/verify?")) {
        if (!routes.sendMagicLink) throw new Error("authtempo compat: no sendMagicLink");
        await routes.sendMagicLink({ email: message.to, url: link, token });
        return;
      }
      if (at(link, "/user/change-email/confirm?")) {
        if (!routes.sendVerificationEmail)
          throw new Error("authtempo compat: no sendVerificationEmail");
        // Better Auth 1.7.2 sends the change link through sendVerificationEmail,
        // with the new address as the user's email (update-user.mjs:513 to :521).
        const row = await routes.storage.findOne("verification", [
          { field: "valueHash", op: "eq", value: await sha256Hex(token) },
          { field: "purpose", op: "eq", value: "email-change" },
        ]);
        const owner = row
          ? await routes.storage.findOne("user", [{ field: "id", op: "eq", value: row.identifier }])
          : null;
        if (!owner) throw new Error("authtempo compat: the user of this change is gone");
        await routes.sendVerificationEmail({
          user: { ...toUser(owner), email: message.to },
          url: link,
          token,
        });
        return;
      }
      if (at(link, "/user/delete/confirm?")) {
        const cb = routes.sendDeleteAccountVerification;
        if (!cb) throw new Error("authtempo compat: no sendDeleteAccountVerification");
        // Better Auth 1.7.2 passes the session's user (update-user.mjs:325 to :329).
        // The row's identifier is the user id (core's `account-delete` purpose).
        const row = await routes.storage.findOne("verification", [
          { field: "valueHash", op: "eq", value: await sha256Hex(token) },
          { field: "purpose", op: "eq", value: "account-delete" },
        ]);
        const owner = row
          ? await routes.storage.findOne("user", [{ field: "id", op: "eq", value: row.identifier }])
          : null;
        if (!owner) throw new Error("authtempo compat: the user of this delete is gone");
        await cb({ user: toUser(owner), url: link, token });
        return;
      }
      throw new Error(
        `authtempo compat: no Better Auth send callback for the mail "${message.subject}"`,
      );
    },
  };
}
