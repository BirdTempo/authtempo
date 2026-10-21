# @authtempo/observe

The owned sinks of the authtempo event port: Workers Logs and Analytics
Engine. Core emits one typed event for each authentication act, each limit
hit, each sweep, and each fault (`EVENTS` of `@authtempo/core/observe`). A sink
gets the events after the answer. This package has no runtime dependency and
imports no Node module. Its peer is `@authtempo/core`.

## Install

When the package is on npm, run `pnpm add @authtempo/observe`.
Publication is on hold. In this workspace, add it with `"workspace:*"`.

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

| Option | Default | What it does |
| --- | --- | --- |
| `minLevel` | `"info"` | The lowest level that the sink writes. Another value stops `workersLogsSink` with a `TypeError`. |
| `secrets` | `[]` | Values that no field may hold. The sink replaces each one with `***` in each string field. |

## Analytics Engine

```ts
import { analyticsEngineSink } from "@authtempo/observe/analytics-engine";

const sink = analyticsEngineSink(env.AUTH_EVENTS);
```

The sink writes one data point for each event of a chosen list. The default
list is `request`, `sign_in`, `second_factor.challenge`, `limit.hit`, and
`sweep`; the `events` option sets another. The index is the event name. The
blobs come in the order of `AE_BLOBS`: `name`, `route`, `outcome`, `code`,
`method`, `provider`, `family`, `traceId`, with `null` for an absent field.
The doubles are `[1, durationMs, status]`, with `0` for an absent number.

A flush writes at most 200 data points (`AE_MAX_POINTS`). Analytics Engine
takes at most 250 for each Worker invocation. Over the cap, the sink writes the
first 200 and throws a `RangeError` that names the rest. Core then counts the
batch in `sink_threw` of `auth.observe.stats()`.

Analytics Engine samples by index on write and on read. Read a count with
`SUM(_sample_interval)`, never `COUNT()`.

## What a sink never gets

An event holds no secret, no credential, and no free text. It holds no
address unless the app turns on `observe.include`. A raw email is never in an
event.
