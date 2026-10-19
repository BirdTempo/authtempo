// The binding that vitest.config.ts adds for the tests only (plan 11b Task 12).
declare global {
  namespace Cloudflare {
    interface Env {
      /** Answers the list of each request that left the Worker, as "METHOD URL". */
      OUTBOUND_LOG: Fetcher;
    }
  }
}

export {};
