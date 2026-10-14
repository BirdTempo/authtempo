import { authSession } from "@authtempo/next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "../../lib/auth";

// The proxy sends a request with no cookie away; this page checks that the session is live.
export default async function Account() {
  const session = await authSession(getAuth, await headers());
  if (!session) redirect("/sign-in?next=/account");
  return <p>Your account: {session.user.email}</p>;
}
