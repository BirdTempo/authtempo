import type { MailPort, StorageAdapter } from "@tempo-auth/core";
import type {
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

export interface MailRoutes {
  origin: string;
  basePath: string;
  storage: StorageAdapter;
  sendResetPassword?: SendEmail | undefined;
  sendVerificationEmail?: SendEmail | undefined;
  sendMagicLink?: MagicLinkOptions["sendMagicLink"] | undefined;
  sendInvitationEmail?: OrganizationOptions["sendInvitationEmail"] | undefined;
}

/** Core writes the link on its own paragraph in every mail (engine/password.ts, magic-link.ts, invitations.ts). */
const LINK_RE = /\n\n(\S+)\n\n/;

async function sha256Hex(text: string): Promise<string> {
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
    if (!u) throw new Error(`tempo-auth compat: no user for the mail to ${email}`);
    return toUser(u);
  };
  return {
    async send(message) {
      const link = LINK_RE.exec(message.text)?.[1];
      if (!link)
        throw new Error(`tempo-auth compat: the mail "${message.subject}" carries no link`);
      if (link.startsWith(INVITATION_LINK_PREFIX)) {
        const cb = routes.sendInvitationEmail;
        if (!cb) throw new Error("tempo-auth compat: no sendInvitationEmail");
        const token = link.slice(INVITATION_LINK_PREFIX.length);
        const row = await routes.storage.findOne("invitation", [
          { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
        ]);
        if (!row) throw new Error("tempo-auth compat: the invitation of this mail is gone");
        const org = await routes.storage.findOne("organization", [
          { field: "id", op: "eq", value: row.organizationId },
        ]);
        const inviter = await routes.storage.findOne("user", [
          { field: "id", op: "eq", value: row.inviterId },
        ]);
        if (!org || !inviter)
          throw new Error(
            "tempo-auth compat: the organization or the inviter of this invitation is gone",
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
      const token = new URL(link).searchParams.get("token") ?? "";
      if (link.startsWith(`${prefix}/password/verify?`)) {
        if (!routes.sendVerificationEmail)
          throw new Error("tempo-auth compat: no sendVerificationEmail");
        await routes.sendVerificationEmail({
          user: await userByEmail(message.to),
          url: link,
          token,
        });
        return;
      }
      if (link.startsWith(`${prefix}/password/reset?`)) {
        if (!routes.sendResetPassword) throw new Error("tempo-auth compat: no sendResetPassword");
        await routes.sendResetPassword({ user: await userByEmail(message.to), url: link, token });
        return;
      }
      if (link.startsWith(`${prefix}/magic-link/verify?`)) {
        if (!routes.sendMagicLink) throw new Error("tempo-auth compat: no sendMagicLink");
        await routes.sendMagicLink({ email: message.to, url: link, token });
        return;
      }
      throw new Error(
        `tempo-auth compat: no Better Auth send callback for the mail "${message.subject}"`,
      );
    },
  };
}
