import type { Client } from "@authtempo/client";

/**
 * The delete button of a settings page. A stale session answers
 * `session_not_fresh`. Then `withFresh` asks for an email code once, and sends
 * the delete again. A second refusal is the answer: `withFresh` never loops.
 * `askCode` is the app's own prompt.
 */
export async function deleteAccount(client: Client, askCode: () => Promise<string>) {
  return client.withFresh(
    () => client.user.delete(),
    async () => {
      const sent = await client.reauth.requestEmailCode();
      if (!sent.ok) return sent;
      return client.reauth.emailCode({ emailCode: await askCode() });
    },
  );
}
