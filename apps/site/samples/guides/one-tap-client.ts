/** The part of Google Identity Services that the page uses. */
export interface GoogleId {
  initialize(options: {
    client_id: string;
    nonce: string;
    callback: (answer: { credential: string }) => void;
  }): void;
  prompt(): void;
}

const API = "https://api.example.com/auth";

/** Shows One Tap. The nonce goes to Google as its hash, and to core as itself. */
export async function showOneTap(google: GoogleId, done: (ok: boolean) => void): Promise<void> {
  const res = await fetch(`${API}/social/google/id-token/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const { nonce, providerNonce } = (await res.json()) as { nonce: string; providerNonce: string };
  google.initialize({
    client_id: "web-client.apps.googleusercontent.com",
    // Google puts this value in the token. Never give it the raw nonce.
    nonce: providerNonce,
    callback: async ({ credential }) => {
      const signIn = await fetch(`${API}/social/google/id-token`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: credential, nonce }),
      });
      done(signIn.ok);
    },
  });
  google.prompt();
}
