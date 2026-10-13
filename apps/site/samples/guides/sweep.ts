import {
  type Auth,
  type Clock,
  createAuth,
  type MailPort,
  type StorageAdapter,
  systemClock,
} from "@authtempo/core";

export function createSweepAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  clock: Clock = systemClock,
) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    clock,
  });
}

/**
 * The scheduled handler of a Worker. A cron trigger in wrangler.jsonc calls
 * it. The counts hold no secret, so the log line may carry them.
 */
export function sweepHandler(getAuth: () => Auth) {
  return {
    async scheduled(
      _controller: unknown,
      _env: unknown,
      ctx: { waitUntil(p: Promise<unknown>): void },
    ) {
      ctx.waitUntil(
        getAuth()
          .api.sweepExpired()
          .then((counts) => console.log("authtempo sweep", JSON.stringify(counts))),
      );
    },
  };
}
