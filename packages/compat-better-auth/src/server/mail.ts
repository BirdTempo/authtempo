import type { MailMessage, MailPort, StorageAdapter } from "@authtempo/core";
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

/** The mail that core's `emailOtp.mail` and `emailOtp.resetMail` answer here. */
export function otpMail(
  to: string,
  type: "sign-in" | "forget-password",
  code: string,
): MailMessage {
  return {
    to,
    subject: "authtempo compat email code",
    text: `\n\n${OTP_LINK_PREFIX}${type}:${code}\n\n`,
  };
}

export interface MailRoutes {
  origin: string;
  basePath: string;
  storage: StorageAdapter;
  sendResetPassword?: SendEmail | undefined;
  sendVerificationEmail?: SendEmail | undefined;
  sendMagicLink?: MagicLinkOptions["sendMagicLink"] | undefined;
  sendVerificationOTP?: EmailOtpOptions["sendVerificationOTP"] | undefined;
  sendInvitationEmail?: OrganizationOptions["sendInvitationEmail"] | undefined;
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
  const prefix = `${routes.origin}${routes.basePath}`;
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
        if ((type !== "sign-in" && type !== "forget-password") || !otp)
          throw new Error("authtempo compat: the email code mail is malformed");
        // Better Auth sends a reset code only to an address with a user
        // (routes.mjs requestPasswordResetEmailOTP, read 2026-10-13). Send
        // nothing and do not throw: a throw answers 500, and that difference
        // is the tell.
        if (type === "forget-password" && !(await userByEmail(message.to))) return;
        await cb({ email: message.to, otp, type });
        return;
      }
      const token = new URL(link).searchParams.get("token") ?? "";
      if (link.startsWith(`${prefix}/password/verify?`)) {
        if (!routes.sendVerificationEmail)
          throw new Error("authtempo compat: no sendVerificationEmail");
        await routes.sendVerificationEmail({
          user: await knownUser(message.to),
          url: link,
          token,
        });
        return;
      }
      if (link.startsWith(`${prefix}/password/reset?`)) {
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
      if (link.startsWith(`${prefix}/magic-link/verify?`)) {
        if (!routes.sendMagicLink) throw new Error("authtempo compat: no sendMagicLink");
        await routes.sendMagicLink({ email: message.to, url: link, token });
        return;
      }
      throw new Error(
        `authtempo compat: no Better Auth send callback for the mail "${message.subject}"`,
      );
    },
  };
}
