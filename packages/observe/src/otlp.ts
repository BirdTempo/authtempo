/**
 * The OTLP sink of `@authtempo/observe` (plan 12h, spec 31 item 13).
 *
 * Owned OTLP over HTTP with JSON (OTLP 1.11.0, read 2026-10-14; Cloudflare's
 * export takes JSON only). No OpenTelemetry SDK: a supplier change cannot
 * break this promise. No retry: one flush stays inside flushTimeoutMs.
 *
 * One flush posts each chosen signal once, at the same time, to
 * `<endpoint>/v1/logs`, `/v1/traces`, and `/v1/metrics`. An answer other than
 * 2xx throws, so the observer counts the batch in `sink_threw`. OTLP names
 * 429, 502, 503, and 504 as codes to retry (docs/specification.md, "Retryable
 * Response Codes"). The sink does not retry them: the events are counted as
 * lost, and the next flush sends new events.
 */
import type { ObserveSink } from "@authtempo/core/observe";
import { secretParts } from "@authtempo/core/redact";
import { scrubEvent } from "./event-scrub.js";
import { aggregate } from "./metrics.js";
import { logsBody, metricsBody, tracesBody } from "./otlp-json.js";

export type OtlpSignal = "logs" | "traces" | "metrics";

/** The signals in the order of their posts. */
export const OTLP_SIGNALS: readonly OtlpSignal[] = ["logs", "traces", "metrics"];

export interface OtlpOptions {
  /** The base URL of the collector, http or https, with no query. The sink appends `/v1/<signal>`. */
  endpoint: string;
  /** The `service.name` resource attribute of each body. */
  serviceName: string;
  /** Headers of each post, such as an API key. The sink sets `content-type` itself. */
  headers?: Readonly<Record<string, string>>;
  /** The fetch of the app. Default the global `fetch`. */
  fetch?: typeof fetch;
  /** The signals to post. Default all three. */
  signals?: readonly OtlpSignal[];
  /**
   * Values that no body may hold, such as a secret of the app. The sink adds
   * each header value. This list is the last guard of spec 31 item 9.
   */
  secrets?: readonly string[];
}

/**
 * The parts of a header value that a body may never hold. They are the value
 * and the credential after the scheme, such as the token of `Bearer <token>`.
 */
function headerParts(value: string): string[] {
  const token = value.trim().split(/\s+/).at(-1) ?? "";
  return [...secretParts(value), ...secretParts(token)];
}

/** The base URL with no slash at the end. It refuses a URL that the sink cannot post to. */
function baseOf(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError("otlpSink: endpoint must be an absolute http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("otlpSink: endpoint must be an absolute http or https URL");
  if (url.search !== "" || url.hash !== "")
    throw new TypeError("otlpSink: endpoint must have no query and no fragment");
  return url.href.replace(/\/+$/, "");
}

function signalsOf(signals: readonly OtlpSignal[] | undefined): ReadonlySet<OtlpSignal> {
  if (signals === undefined) return new Set(OTLP_SIGNALS);
  if (signals.length === 0 || signals.some((s) => !OTLP_SIGNALS.includes(s)))
    throw new TypeError("otlpSink: signals must name one or more of logs, traces, and metrics");
  return new Set(signals);
}

/**
 * The sink. It refuses a bad endpoint, an empty service name, and an unknown
 * signal at once with a `TypeError`. A typo never loses every event in silence.
 */
export function otlpSink(options: OtlpOptions): ObserveSink {
  const base = baseOf(options.endpoint);
  if (typeof options.serviceName !== "string" || options.serviceName === "")
    throw new TypeError("otlpSink: serviceName must be a string that is not empty");
  const { serviceName } = options;
  const chosen = signalsOf(options.signals);
  const given = options.headers ?? {};
  const headers = new Headers(given);
  headers.set("content-type", "application/json");
  const secrets = new Set([
    ...(options.secrets ?? []).flatMap((s) => secretParts(s)),
    ...Object.values(given).flatMap(headerParts),
  ]);
  // Read at each post, so the global fetch is called as a method of the global scope.
  const send: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function post(signal: OtlpSignal, body: unknown): Promise<void> {
    const res = await send(`${base}/v1/${signal}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // A redirect could send the header values to another host. A 3xx throws below.
      redirect: "manual",
    });
    // The sink reads no text of an answer. The cancel frees the connection.
    await res.body?.cancel();
    if (res.status < 200 || res.status > 299)
      throw new RangeError(`otlpSink: /v1/${signal} answered ${res.status}`);
  }

  return {
    async write(batch) {
      const clean = batch.map((event) => scrubEvent(event, secrets));
      const bodies: Record<OtlpSignal, unknown> = {
        logs: chosen.has("logs") ? logsBody(clean, serviceName) : null,
        traces: chosen.has("traces") ? tracesBody(clean, serviceName) : null,
        metrics: chosen.has("metrics") ? metricsBody(aggregate(clean), serviceName) : null,
      };
      // A signal with nothing to send makes no post.
      await Promise.all(
        OTLP_SIGNALS.filter((s) => bodies[s] !== null).map((s) => post(s, bodies[s])),
      );
    },
  };
}
