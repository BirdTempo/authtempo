# @authtempo/observe

The owned sinks of the authtempo event port: Workers Logs, Analytics
Engine, and OTLP. Core emits one typed event for each authentication act, each limit
hit, each sweep, and each fault (`EVENTS` of `@authtempo/core/observe`). A sink
gets the events after the answer. This package has no runtime dependency and
imports no Node module. Its peer is `@authtempo/core`.

## Install

Run `pnpm add @authtempo/observe`.

## Workers Logs

```ts
import { createAuth } from "@authtempo/core";
import { workersLogsSink } from "@authtempo/observe/workers-logs";

const auth = createAuth({ /* … */ observe: { sink: workersLogsSink() } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Bound on purpose: an unbound ctx.waitUntil throws Illegal invocation.
    return auth.handle(request, { waitUntil: (p) => ctx.waitUntil(p) });
  },
};
```

The sink writes one `console` call with one plain object for each event:
`console.log` for `info`, `console.warn` for `warn`, and `console.error` for
`error`. Workers Logs keeps the object as JSON with each field indexed. Set
`observability.enabled` to `true` in `wrangler.jsonc`. Keep
`head_sampling_rate` at `1`: a lower rate drops whole requests, and with them
their sign-in events.

`handle` starts the flush of its own request. A call outside `handle`, such
as `auth.session(request)`, puts its events in the buffer too. On such a path,
start `ctx.waitUntil(auth.observe.flush())` before the answer goes out. Without
it, the events wait for the next `handle` call. When each request builds its
own `Auth`, they are lost.

| Option | Default | What it does |
| --- | --- | --- |
| `minLevel` | `"info"` | The lowest level that the sink writes. Another value stops `workersLogsSink` with a `TypeError`. |
| `secrets` | `[]` | Values that no field may hold, such as `env.AUTH_SECRET`. The sink replaces each one with `***` in each string field. |

## Analytics Engine

```ts
import { analyticsEngineSink } from "@authtempo/observe/analytics-engine";

const sink = analyticsEngineSink(env.AUTH_EVENTS, { secrets: [env.AUTH_SECRET] });
```

The sink writes one data point for each event of a chosen list. The default
list is `request`, `sign_in`, `second_factor.challenge`, `limit.hit`, `sweep`,
and `observe.dropped`, so a lost event shows in the dataset. The `events`
option sets another list. The index is the event name. The
blobs come in the order of `AE_BLOBS`: `name`, `route`, `outcome`, `code`,
`method`, `provider`, `family`, `traceId`, with `null` for an absent field.
The doubles are `[1, durationMs, status]`, with `0` for an absent number.
The fields after the 1 come in the order of `AE_DOUBLES`.

| Option | Default | What it does |
| --- | --- | --- |
| `events` | `AE_DEFAULT_EVENTS` | The events that the sink writes. |
| `secrets` | `[]` | Values that no blob may hold, such as `env.AUTH_SECRET`. The sink replaces each one with `***` in each blob. |

A flush writes at most 200 data points (`AE_MAX_POINTS`). Analytics Engine
takes at most 250 for each Worker invocation. Over the cap, the sink writes the
first 200 and throws a `RangeError` that names the rest. Core then counts the
batch in `sink_threw` of `auth.observe.stats()`. The count holds each event of
the batch, the 200 written points too, so it is higher than the true loss.
The port has one count for each batch: a true count needs a change of the
core port.

Analytics Engine samples by index on write and on read. Read a count with
`SUM(_sample_interval)`, never `COUNT()`.

## OTLP

```ts
import { otlpSink } from "@authtempo/observe/otlp";

const sink = otlpSink({
  endpoint: env.OTLP_ENDPOINT,
  serviceName: "auth",
  headers: { authorization: `Bearer ${env.OTLP_TOKEN}` },
  secrets: [env.AUTH_SECRET],
});
```

The sink posts OTLP 1.11.0 JSON over HTTP with `fetch` to
`<endpoint>/v1/logs`, `/v1/traces`, and `/v1/metrics`. It is our own code over
`fetch`, with no OpenTelemetry package. One flush posts each signal once, at
the same time:

- Logs: one log record for each event, with each field as an attribute.
- Traces: one server span for each `request` event. The other events of its
  trace are span events. An `error` event or a 5xx status sets the status
  `ERROR`.
- Metrics: the delta points of the batch, from the table `METRICS`. The
  request duration is in seconds, with the bucket list
  `HTTP_DURATION_BUCKETS` of the stable HTTP convention. No attribute holds a
  user id, a session id, or an address. Each point starts at the end of the
  last flush of the sink (the first at the sink creation) and ends at this
  flush.

Each body has the resource attributes `service.name` and
`service.instance.id`. The instance id is a random UUID for each sink, so
each isolate and each Auth writes its own metric stream. Make each sink once
for each isolate, with its `Auth`. A sink made for each request gives each
request its own `service.instance.id`, and so its own metric stream.

A signal with nothing to send makes no post. Each post has
`redirect: "manual"`, so a redirect never sends the headers to another host.
An answer other than 2xx throws a `RangeError` that names the path and the
status, and core counts the batch in `sink_threw`. The sink makes no retry,
also for 429, 502, 503, and 504. The sink reads no text of an answer.

Each post aborts after `timeoutMs`. Core stops its wait for a write at
`flushTimeoutMs`, but it cannot stop a fetch. Give `timeoutMs` the same value
as `flushTimeoutMs`, so no post outlives its flush. A post with no end holds a
connection: Workers lets 6 connections wait for headers in one invocation, and
`waitUntil` runs for at most 30 s after the answer (read 2026-10-21).

| Option | Default | What it does |
| --- | --- | --- |
| `endpoint` | required | The base URL of the collector, `http` or `https`, with no query and no fragment. |
| `serviceName` | required | The `service.name` resource attribute. |
| `headers` | `{}` | The headers of each post. The sink sets `content-type: application/json` itself. |
| `fetch` | the global `fetch` | The fetch of the app. |
| `signals` | all three | The signals to post: `logs`, `traces`, `metrics`. |
| `secrets` | `[]` | Values that no body may hold. The sink adds each header value, and the token after the scheme, such as `Bearer`. |
| `timeoutMs` | `2000` | The time in ms after which a post aborts, 100 to 10000. The default and the bound are those of `flushTimeoutMs` in core. |

The scrub of each sink skips the stamp fields of core, `STAMP_FIELDS`:
`name`, `level`, `at`, `traceId`, `spanId`, `parentSpanId`, and `route`. It
also skips each field whose kind in `EVENTS` is `enum`, `code`, `route`, or
`routePath`. Core holds each such value to a closed list, so it holds no
free text. So a short header value, such as `limit` or `oauth`, never changes
the event name `limit.hit` or the route `POST /oauth/token`.

A bad `endpoint`, an empty `serviceName`, an unknown or empty `signals` list,
or a `timeoutMs` that is not an integer from 100 to 10000 stops `otlpSink`
with a `TypeError`.

## What a sink never gets

An event holds no secret, no credential, and no free text. It holds no
address unless the app turns on `observe.include`. A raw email is never in an
event.

As the last guard, an app passes the secret values of its config to each sink
it builds. Give the same `secrets` list, such as `[env.AUTH_SECRET]`, to
`workersLogsSink`, to `analyticsEngineSink`, and to `otlpSink` (spec 31 item 9).
