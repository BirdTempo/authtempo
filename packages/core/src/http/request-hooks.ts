import type { ResolvedConfig } from "../config.js";
import {
  HookRefusal,
  publicHookMessage,
  type RequestAfterEvent,
  type RequestHookEvent,
} from "../engine/hooks.js";
import { ERRORS } from "../errors.js";
import { hookBodyBytes, parseBodyJson } from "./body-cap.js";
import { holdsBadText } from "./body-text.js";
import { respond } from "./json.js";
import type { RouteKey } from "./route-list.js";

/**
 * The request points of `hooks.request` (an integrator report of
 * 2026-11-25). The router calls them around the handler of a matched route.
 * The app's code gets values that core makes new for it: a change of the
 * headers or of the URL changes nothing of the request that the handler
 * reads. The body comes through `hookBodyBytes`, the one capped read.
 */

/** What the router knows of the request at the hook. */
export interface RequestHookInput {
  request: Request;
  url: URL;
  key: RouteKey;
  params: Record<string, string>;
  ip: string | null;
}

/** True for a body that the JSON readers of core take: `application/json`, with or without a parameter. */
function isJson(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
}

/**
 * The values of the path parameters of the route key, read from the path of
 * the request. The router mounts some routes with a fixed path for each
 * value, such as `/social/github/start` for the key
 * `GET /social/:provider/start`, and it then parses no parameter. So the
 * hook reads the key and the path, and each route gives its parameters in
 * one way. A path that does not have the form of the key, such as the alias
 * of a route, keeps the parameters of the router.
 */
function paramsOf(input: RequestHookInput, basePath: string): Record<string, string> {
  const pattern = input.key.slice(input.key.indexOf(" ") + 1).split("/");
  const path = input.url.pathname.startsWith(basePath)
    ? input.url.pathname.slice(basePath.length).split("/")
    : [];
  if (pattern.length !== path.length) return { ...input.params };
  const params: Record<string, string> = {};
  for (const [i, part] of pattern.entries()) {
    const value = path[i] ?? "";
    if (part.startsWith(":")) {
      try {
        params[part.slice(1)] = decodeURIComponent(value);
      } catch {
        params[part.slice(1)] = value;
      }
    } else if (part !== value) return { ...input.params };
  }
  return params;
}

function eventOf(input: RequestHookInput, basePath: string): RequestHookEvent {
  const { request } = input;
  let read: Promise<unknown> | undefined;
  return {
    route: input.key,
    params: paramsOf(input, basePath),
    url: new URL(input.url.href),
    headers: new Headers(request.headers),
    ip: input.ip,
    json() {
      // One read for each request: a second call answers the first value.
      read ??= (async () => {
        if (!isJson(request)) return undefined;
        const bytes = await hookBodyBytes(request);
        if (bytes === undefined || bytes === null) return undefined;
        const raw = parseBodyJson(new TextDecoder().decode(bytes));
        // The readers of core refuse a NUL and a lone surrogate. The hook gets no such body.
        return raw === undefined || holdsBadText(raw) ? undefined : raw;
      })();
      return read;
    },
  };
}

function isRefusal(e: unknown): e is Error {
  // The name too: a second copy of this package in one bundle has its own class.
  return e instanceof HookRefusal || (e instanceof Error && e.name === "HookRefusal");
}

/**
 * Runs `hooks.request.before`. Null lets the handler run. A refusal answers
 * 403 `hook_refused` with the message. Any other throw answers 500
 * `hook_failed` and emits `hook.before_failed`, as each other before hook
 * does. A throw of the body read is not the hook's: a body past the cap
 * goes on to the router, which answers 413.
 */
export async function requestBefore(
  config: ResolvedConfig,
  input: RequestHookInput,
): Promise<Response | null> {
  const hook = config.hooks.request.before;
  if (!hook) return null;
  try {
    await hook(eventOf(input, config.basePath));
    return null;
  } catch (e) {
    if (isRefusal(e))
      return respond({
        ok: false,
        code: "hook_refused",
        status: ERRORS.hook_refused,
        message: publicHookMessage(e.message),
      });
    if (isBodyError(e)) throw e;
    config.observe.emit({ name: "hook.before_failed", hook: "request.before", errorName: e });
    return respond({ ok: false, code: "hook_failed", status: ERRORS.hook_failed });
  }
}

/** The three errors of a body read. The router answers each one: 413, 503, and 408. */
function isBodyError(e: unknown): boolean {
  const name = e instanceof Error ? e.name : "";
  return name === "BodyTooLarge" || name === "BodyBusy" || name === "BodyTimeout";
}

/**
 * Runs `hooks.request.after` with the status and the code of the answer. The
 * answer stays: a throw emits `hook.after_failed` with no row id, and core
 * sends the answer of the handler. The event carries the route of the request.
 */
export async function requestAfter(
  config: ResolvedConfig,
  input: RequestHookInput,
  answer: { status: number; code: string | null },
): Promise<void> {
  const hook = config.hooks.request.after;
  if (!hook) return;
  const event: RequestAfterEvent = { ...eventOf(input, config.basePath), ...answer };
  try {
    await hook(event);
  } catch (e) {
    if (isBodyError(e)) return;
    config.observe.emit({ name: "hook.after_failed", hook: "request.after", errorName: e });
  }
}
