import { type Client, createClient } from "@authtempo/client";

/** The client of the browser app. It sends the session cookie to the API origin. */
export function createAppClient(fetchImpl: typeof fetch = globalThis.fetch): Client {
  return createClient({ baseURL: "https://api.example.com", fetch: fetchImpl });
}

/** The sign-in form posts the address. The API mails a link that lands on /welcome. */
export async function askForLink(client: Client, email: string): Promise<string> {
  const r = await client.magicLink.request({ email, next: "/welcome" });
  return r.ok ? "Check your mail for the sign-in link." : `The request failed: ${r.code}.`;
}

/** The page at /welcome shows the signed-in address. Show it after every sign-in. */
export async function welcome(client: Client): Promise<string> {
  const r = await client.session();
  if (!r.ok) return `The API did not answer: ${r.code}.`;
  return r.value ? `Signed in as ${r.value.user.email}.` : "Not signed in.";
}

/** The sign-out button. The API deletes the session and clears the cookie. */
export async function signOut(client: Client): Promise<boolean> {
  return (await client.signOut()).ok;
}
