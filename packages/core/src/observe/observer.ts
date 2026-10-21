import type { Clock } from "../primitives/clock.js";
import { CONTROL, keyedHash } from "../redact.js";
import type { ResolvedObserve } from "./config.js";
import type { AuthEvent, EventName, ObserveStats } from "./port.js";

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
  emit(event: { name: EventName } & Record<string, unknown>): void;
  /** An observer that stamps the ids of one request and shares the buffer and the counts. */
  scope(scope: RequestScope): Observer;
  flush(): Promise<void>;
  stats(): ObserveStats;
}

/** The info strings of the two keyed hashes (spec 31 item 8). A new info gives new hashes. */
const IP_INFO = "authtempo observe ip v1";
const EMAIL_INFO = "authtempo observe email v1";
/** A raw user agent is cut to this length (spec 31 item 8). */
const USER_AGENT_MAX = 256;
/** Fields that only the include rule writes. A flow cannot pass them through. */
const ADDRESS_FIELDS = new Set(["ip", "ipHash", "userAgent", "email", "emailHash"]);

type Dropped = ObserveStats["dropped"];

/** An event in the buffer, with the raw addresses that the flush hashes. They stay in memory. */
interface Held {
  event: AuthEvent;
  ip?: string;
  email?: string;
}

function hex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The level of an event. Plan 12h Task 3 reads it from `EVENTS`. */
function levelOf(name: EventName): AuthEvent["level"] {
  return name === "observe.dropped" ? "warn" : "info";
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
  deps: { clock: Clock; hashSecret: () => string },
): Observer {
  let buffer: Held[] = [];
  let dropped = noDrops();

  function stamp(name: EventName, scope: RequestScope | null): AuthEvent {
    const ids = scope ?? { traceId: hex(16), spanId: hex(8), parentSpanId: null };
    return {
      name,
      level: levelOf(name),
      at: deps.clock.now().toISOString(),
      traceId: ids.traceId,
      spanId: ids.spanId,
      ...(ids.parentSpanId !== null ? { parentSpanId: ids.parentSpanId } : {}),
      ...(scope ? { route: scope.route } : {}),
    };
  }

  function hold(input: { name: EventName } & Record<string, unknown>, scope: RequestScope | null) {
    const event = stamp(input.name, scope);
    const held: Held = { event };
    for (const [key, value] of Object.entries(input)) {
      if (key === "name" || ADDRESS_FIELDS.has(key) || Object.hasOwn(event, key)) continue;
      event[key] = value;
    }
    const { include } = config;
    if (scope?.ip) {
      if (include.ip === "raw") event.ip = scope.ip;
      else if (include.ip === "hash") held.ip = scope.ip;
    }
    if (scope?.userAgent && include.userAgent === "raw")
      event.userAgent = scope.userAgent
        .replace(CONTROL, "")
        .replaceAll("\t", "")
        .slice(0, USER_AGENT_MAX);
    if (include.email === "hash" && typeof input.email === "string") held.email = input.email;
    return held;
  }

  /** The event that reports the drops since the last report, at the head of a batch. */
  function droppedEvent(counts: Dropped): AuthEvent {
    return { ...stamp("observe.dropped", null), ...counts };
  }

  async function finish(held: Held, secret: () => string): Promise<AuthEvent> {
    const { event } = held;
    if (held.ip !== undefined) event.ipHash = await keyedHash(secret(), IP_INFO, held.ip);
    if (held.email !== undefined)
      event.emailHash = await keyedHash(secret(), EMAIL_INFO, held.email);
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
      // The secret is read at the flush, so a rotation applies at the next flush.
      let secret: string | undefined;
      const read = () => {
        secret ??= deps.hashSecret();
        return secret;
      };
      const events = await Promise.all(held.map((h) => finish(h, read)));
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

  function make(scope: RequestScope | null): Observer {
    return {
      emit(input) {
        if (buffer.length >= config.buffer) {
          dropped.buffer_full += 1;
          return;
        }
        buffer.push(hold(input, scope));
      },
      scope: (next) => make(next),
      flush,
      stats: () => ({ buffered: buffer.length, dropped: { ...dropped } }),
    };
  }

  return make(null);
}

/**
 * The observer with no `observe` config: it sends nothing anywhere. Plan 12h
 * Task 3 replaces this with the default output.
 */
export function createDefaultObserver(): Observer {
  const observer: Observer = {
    emit() {},
    scope: () => observer,
    flush: async () => {},
    stats: () => ({ buffered: 0, dropped: noDrops() }),
  };
  return observer;
}
