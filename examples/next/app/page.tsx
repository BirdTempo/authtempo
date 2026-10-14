import { authSession } from "@authtempo/next";
import { headers } from "next/headers";
import { getAuth } from "../lib/auth";

export default async function Home() {
  const session = await authSession(getAuth, await headers());
  return (
    <main>
      {session ? <p>Signed in as {session.user.email}</p> : <a href="/sign-in">Sign in</a>}
    </main>
  );
}
