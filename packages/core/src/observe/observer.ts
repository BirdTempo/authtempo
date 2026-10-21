import { isIpLiteral } from "../limiter/ip-key.js";
import type { Clock } from "../primitives/clock.js";
import { CONTROL, KEYED_HASH_INFO, keyedHashKey, keyedHashWith, scrub } from "../redact.js";
import type { ResolvedObserve } from "./config.js";
import { defaultOutput } from "./default-output.js";
import { type EventInput, type EventName, specOf, validateEvent } from "./events.js";
import type { AuthEvent, ObserveStats } from "./port.js";
import { mintTrace } from "./trace.js";

/** The request that an event belongs to. The router builds it (plan 12h Task 4). */
export interface RequestScope {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  route: string;
  ip: string | null;
  userAgent: string | null;
}

/**
 * One observer for each `Auth` instance. `emit` is synchronous and never
 * calls the sink. `flush` sends the buffer to the sink, after the answer.
 */
export interface Observer {
  emit(event: EventInput): void;
  /** An observer that stamps the ids of one request and shares the buffer and the counts. */
  scope(scope: RequestScope): Observer;
  /**
   * The observer of the config that the route modules get at construction.
   * It marks each event `unscoped` and gives it a new trace, so the recorder
   * finds a handler that emits outside the scope of its request.
   */
  unscoped(): Observer;
  flush(): Promise<void>;
  stats(): ObserveStats;
}

/** A raw user agent is cut to this length (spec 31 item 8). */
const USER_AGENT_MAX = 256;
/** Fields that only the include rule writes. A flow cannot pass them through. */
const ADDRESS_FIELDS = new Set(["ip", "ipHash", "userAgent", "email", "emailHash"]);

type Dropped = ObserveStats["dropped"];

/** The two HMAC keys of one flush. Each is derived at its first use, and once. */
interface FlushKeys {
  ip: () => Promise<CryptoKey>;
  email: () => Promise<CryptoKey>;
}

/** An event in the buffer, with the raw addresses that the flush hashes. They stay in memory. */
interface Held {
  event: AuthEvent;
  ip?: string;
  email?: string;
}

/** A new trace id and span id, for an event outside a request. */
function freshIds() {
  return { ...mintTrace(), parentSpanId: null };
}

/** The stamp of an event: its name, its level from `EVENTS`, the time, and the ids of its scope. */
function stamped(name: EventName, clock: Clock, scope: RequestScope | null): AuthEvent {
  const ids = scope ?? freshIds();
  return {
    name,
    level: specOf(name).level,
    at: clock.now().toISOString(),
    traceId: ids.traceId,
    spanId: ids.spanId,
    ...(ids.parentSpanId !== null ? { parentSpanId: ids.parentSpanId } : {}),
    ...(scope ? { route: scope.route } : {}),
  };
}

/**
 * The fields of an input after the kinds, with the address fields left out:
 * only the include rule writes an address. A rejected field is named in
 * `rejected` (spec 31 item 7).
 */
function checkedFields(input: EventInput): Record<string, unknown> {
  const passed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input))
    if (!ADDRESS_FIELDS.has(key)) passed[key] = value;
  const { fields, rejected } = validateEvent(input.name, passed);
  return rejected.length > 0 ? { ...fields, rejected } : fields;
}

function noDrops(): Dropped {
  return { buffer_full: 0, sink_timeout: 0, sink_threw: 0 };
}

/**
 * The observer of an `observe` config. No `await` of `flush` appears in a
 * flow or in the router: the host runs it after the answer (spec 31 item 4).
 */
export function createObserver(
  config: ResolvedObserve,
  deps: { clock: Clock; hashSecret: () => string; secrets: ReadonlySet<string> },
): Observer {
  let buffer: Held[] = [];
  let dropped = noDrops();

  const stamp = (name: EventName, scope: RequestScope | null) => stamped(name, deps.clock, scope);

  function hold(input: EventInput, scope: RequestScope | null, unscoped: boolean) {
    const event = stamp(input.name, scope);
    const held: Held = { event };
    // The scrub of the default output, also with a sink: no sink is the only
    // guard of a secret (spec 31 item 9). A field kind can keep a secret that
    // a client sends, such as a method token. The stamp is set first and is
    // not scrubbed. Its kinds check the name, the level, the time, the ids,
    // and the route key (STAMP_FIELDS). A sink of @authtempo/observe scrubs
    // again with the secrets of the app. It skips the same fields, and each
    // field of a closed list.
    for (const [key, value] of Object.entries(checkedFields(input)))
      if (!Object.hasOwn(event, key))
        event[key] = typeof value === "string" ? scrub(value, deps.secrets) : value;
    if (unscoped) event.rejected = [...(event.rejected ?? []), "unscoped"];
    const { include } = config;
    // The raw IP and the raw agent come from the client, so each one gets the
    // scrub too. Outside the Cloudflare edge a client sets cf-connecting-ip
    // (workersClientIp reads it with no check). So a raw IP that is not an IP
    // address after the scrub is dropped.
    if (scope?.ip) {
      if (include.ip === "raw") {
        const ip = scrub(scope.ip, deps.secrets);
        if (isIpLiteral(ip)) event.ip = ip;
      } else if (include.ip === "hash") held.ip = scope.ip;
    }
    // The scrub comes before the cut: a cut through a secret would keep its head.
    if (scope?.userAgent && include.userAgent === "raw")
      event.userAgent = scrub(
        scope.userAgent.replace(CONTROL, "").replaceAll("\t", ""),
        deps.secrets,
      ).slice(0, USER_AGENT_MAX);
    if (include.email === "hash" && typeof input.email === "string") held.email = input.email;
    return held;
  }

  /** The event that reports the drops since the last report, at the head of a batch. */
  function droppedEvent(counts: Dropped): AuthEvent {
    return { ...stamp("observe.dropped", null), ...counts };
  }

  async function finish(held: Held, keys: FlushKeys): Promise<AuthEvent> {
    const { event } = held;
    if (held.ip !== undefined) event.ipHash = await keyedHashWith(await keys.ip(), held.ip);
    if (held.email !== undefined)
      event.emailHash = await keyedHashWith(await keys.email(), held.email);
    return event;
  }

  async function flush(): Promise<void> {
    // The swap comes first: a second flush that starts now sees only new events.
    const held = buffer;
    buffer = [];
    const carried = dropped;
    const report = carried.buffer_full + carried.sink_timeout + carried.sink_threw > 0;
    if (held.length === 0 && !report) return;
    dropped = noDrops();
    let outcome: "ok" | "timeout" | "threw";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // One yield after the swap: the caller of flush gets its promise back
      // before any key work or hash starts.
      await Promise.resolve();
      // The secret is read once at the flush, so a rotation applies at the next flush.
      // Each key is derived once for the flush, not once for each event.
      let secret: string | undefined;
      let ipKey: Promise<CryptoKey> | undefined;
      let emailKey: Promise<CryptoKey> | undefined;
      const keys: FlushKeys = {
        ip: () => {
          secret ??= deps.hashSecret();
          ipKey ??= keyedHashKey(secret, KEYED_HASH_INFO.ip);
          return ipKey;
        },
        email: () => {
          secret ??= deps.hashSecret();
          emailKey ??= keyedHashKey(secret, KEYED_HASH_INFO.email);
          return emailKey;
        },
      };
      const events = await Promise.all(held.map((h) => finish(h, keys)));
      const batch = report ? [droppedEvent(carried), ...events] : events;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), config.flushTimeoutMs);
      });
      const written = Promise.resolve(config.sink.write(batch)).then(
        () => "ok" as const,
        () => "threw" as const,
      );
      outcome = await Promise.race([written, timeout]);
    } catch {
      outcome = "threw";
    } finally {
      clearTimeout(timer);
    }
    if (outcome === "ok") return;
    // A lost batch loses no count: the counts it carried come back, and its events join them.
    // Core logs no error text of a sink (spec 31 item 4).
    dropped.buffer_full += carried.buffer_full;
    dropped.sink_timeout += carried.sink_timeout;
    dropped.sink_threw += carried.sink_threw;
    if (outcome === "timeout") dropped.sink_timeout += held.length;
    else dropped.sink_threw += held.length;
  }

  function make(scope: RequestScope | null, unscoped = false): Observer {
    return {
      emit(input) {
        if (buffer.length >= config.buffer) {
          dropped.buffer_full += 1;
          return;
        }
        buffer.push(hold(input, scope, unscoped));
      },
      scope: (next) => make(next),
      unscoped: () => make(null, true),
      flush,
      stats: () => ({ buffered: buffer.length, dropped: { ...dropped } }),
    };
  }

  return make(null);
}

/**
 * The observer with no `observe` config (owner decision 1 of 2026-10-14). It
 * writes the line of a fault event at once through the default output,
 * ignores every other event, keeps no buffer, and sends nothing anywhere.
 */
export function createDefaultObserver(deps: {
  clock: Clock;
  secrets: ReadonlySet<string>;
}): Observer {
  const observer: Observer = {
    emit(input) {
      if (!specOf(input.name).line) return;
      defaultOutput(
        { ...checkedFields(input), ...stamped(input.name, deps.clock, null) },
        deps.secrets,
      );
    },
    scope: () => observer,
    // A line has no trace, so the mark has nothing to change here.
    unscoped: () => observer,
    flush: async () => {},
    stats: () => ({ buffered: 0, dropped: noDrops() }),
  };
  return observer;
}

/** The observer of the construction config (plan 12h Task 4): it marks each event `unscoped`. */
export function unscopedOf(observer: Observer): Observer {
  return observer.unscoped();
}
