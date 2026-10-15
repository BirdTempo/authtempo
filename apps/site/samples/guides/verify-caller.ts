import { createVerifier, type VerifierOptions } from "@authtempo/verify";

/**
 * A files server that is not the auth app. It knows the person of each
 * request from the session JWT of the app, or from an API token of a script.
 */
export function createFilesServer(fetch?: VerifierOptions["fetch"]) {
  const verifier = createVerifier({
    // baseURL plus basePath of the auth app: the iss of its tokens.
    issuer: "https://api.example.com/auth",
    // The jwtMint.audience entry of this server.
    audience: "https://files.example.com",
    accept: ["session-jwt", "api-token"],
    // A sign-out ends access at once: one live check per request.
    checkSessionEnd: true,
    // Tests pass the auth app in process. A deploy passes nothing.
    ...(fetch ? { fetch } : {}),
  });
  return {
    async fetch(request: Request): Promise<Response> {
      const r = await verifier.verifyRequest(request);
      if (!r.ok) {
        // The live check of this session is over its limit: try again in a minute.
        // Any other failure: the auth app did not answer. Not "sign in again".
        const status = r.code === "rate_limited" ? 429 : 503;
        return Response.json({ error: r.code }, { status });
      }
      // invalidToken tells the client that the token it sent is refused.
      if (r.value === null)
        return verifier.unauthorized({ invalidToken: request.headers.has("authorization") });
      const owner =
        r.value.kind === "session-jwt"
          ? r.value.email
          : r.value.kind === "api-token"
            ? r.value.user.email
            : null;
      return Response.json({ owner });
    },
  };
}
