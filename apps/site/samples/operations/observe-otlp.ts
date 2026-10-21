import { type Auth, createAuth, type MailPort, type StorageAdapter } from "@authtempo/core";
import { otlpSink } from "@authtempo/observe/otlp";

/** The collector of the app: its base URL and its token, both secrets of the host. */
export interface CollectorEnv {
  OTLP_ENDPOINT: string;
  OTLP_TOKEN: string;
  AUTH_SECRET: string;
}

/** The time that core waits for one flush. Each post of the sink aborts at the same time. */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * An Auth that posts its logs, traces, and metrics to an OTLP collector.
 * Make it once for each isolate, so each isolate writes one metric stream.
 */
export function authWithCollector(
  env: CollectorEnv,
  deps: { storage: StorageAdapter; mail: MailPort; fetch?: typeof fetch },
): Auth {
  const sink = otlpSink({
    endpoint: env.OTLP_ENDPOINT,
    serviceName: "auth",
    headers: { authorization: `Bearer ${env.OTLP_TOKEN}` },
    // The sink adds each header value to this list itself.
    secrets: [env.AUTH_SECRET],
    timeoutMs: FLUSH_TIMEOUT_MS,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: ["https://app.example.com"],
    secret: env.AUTH_SECRET,
    storage: deps.storage,
    mail: deps.mail,
    observe: { sink, flushTimeoutMs: FLUSH_TIMEOUT_MS },
  });
}
