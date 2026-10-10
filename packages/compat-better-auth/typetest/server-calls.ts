import { betterAuth } from "../src/server/better-auth.js";
import { consumere, consumeri } from "./options.js";

const cf = betterAuth(consumere);
export async function consumereCalls(request: Request) {
  const session = await cf.api.getSession({ headers: request.headers });
  const userId: string | undefined = session?.user.id;
  const up = await cf.api.signUpEmail({
    body: { email: "a@example.com", password: "correct horse battery", name: "A" },
  });
  const token: string = up.token;
  const signedIn = await cf.api.signInEmail({
    body: { email: "a@example.com", password: "correct horse battery" },
  });
  const again: string = signedIn.token;
  const res: Response = await cf.handler(request);
  return { userId, token, again, res };
}

const mr = betterAuth(consumeri);
export type Auth = typeof mr;
export type Session = Auth["$Infer"]["Session"]["session"];
export type User = Auth["$Infer"]["Session"]["user"];
export const tokenOf = (s: Session): string => s.token;
export const activeOf = (s: Session): string | null => s.activeOrganizationId;
export const nameOf = (u: User): string => u.name;
export async function consumeriMiddleware(
  headers: Headers,
): Promise<{ session: Session; user: User } | null> {
  return mr.api.getSession({ headers });
}

export async function consumerdInvites(headers: Headers) {
  const invitation = await mr.api.createInvitation({
    body: { email: "x@example.com", role: "member", organizationId: "o1" },
    headers,
  });
  await mr.api.cancelInvitation({ body: { invitationId: invitation.id }, headers });
}
