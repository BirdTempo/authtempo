import { type Auth, createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";
import {
  type AnalyticsEngineDatasetLike,
  analyticsEngineSink,
} from "@authtempo/observe/analytics-engine";

/** The binding of `analytics_engine_datasets` in wrangler.jsonc, and the app secret. */
export interface EventsEnv {
  AUTH_EVENTS: AnalyticsEngineDatasetLike;
  AUTH_SECRET: string;
}

/**
 * An Auth that writes one data point for each request, sign-in, second
 * factor challenge, limit hit, sweep, and lost batch. Make it once for
 * each isolate.
 */
export function authWithAnalytics(
  env: EventsEnv,
  deps: { storage: StorageAdapter; mail: MailPort },
): Auth {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: env.AUTH_SECRET,
    storage: deps.storage,
    mail: deps.mail,
    // The secret list is the last guard: the sink replaces each value with *** in each blob.
    observe: { sink: analyticsEngineSink(env.AUTH_EVENTS, { secrets: [env.AUTH_SECRET] }) },
  });
}
