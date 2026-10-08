import { createMemoryLimiter } from "./limiter/memory.js";
import type { LimiterPort } from "./limiter/port.js";
import { type Clock, systemClock } from "./primitives/clock.js";
import type { StorageAdapter } from "./storage/port.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailPort {
  send(message: MailMessage): Promise<void>;
}

export interface AuthConfig {
  /** Path prefix for the auth routes. Default "/auth". */
  basePath?: string;
  /** Origin of the server that mounts `handle`, no path, no trailing slash. */
  baseURL: string;
  /** At least 32 characters. */
  secret: string;
  /** Exact origins and app schemes. No wildcards in version 1. */
  trustedOrigins: string[];
  storage: StorageAdapter;
  mail: MailPort;
  limiter?: LimiterPort;
  /**
   * Reads the client IP for the per-IP limit. The default reads
   * `cf-connecting-ip`, which only Cloudflare sets on Workers. On any other
   * host a caller sets that header freely and can rotate it past the limit,
   * so pass a function that reads the header your trusted proxy sets.
   */
  clientIp?: (request: Request) => string | null;
  clock?: Clock;
  cookieName?: string;
  session?: { ttlDays?: number; slidingRefreshDays?: number };
  magicLink?: { ttlMinutes?: number; linkBuilder?: (token: string, next: string) => string };
}

export interface ResolvedConfig {
  basePath: string;
  baseURL: string;
  secret: string;
  trustedOrigins: ReadonlySet<string>;
  storage: StorageAdapter;
  mail: MailPort;
  limiter: LimiterPort;
  clientIp: (request: Request) => string | null;
  clock: Clock;
  cookieName: string;
  session: { ttlDays: number; slidingRefreshDays: number };
  magicLink: { ttlMinutes: number; linkBuilder: (token: string, next: string) => string };
}

/**
 * The default client IP. On Workers the platform sets `cf-connecting-ip` and
 * a caller cannot forge it. `x-forwarded-for` is not read, because a caller
 * sets it freely. Null when the header is absent.
 */
export function workersClientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip") || null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Applies defaults and refuses a config that cannot keep the security rules. */
export function resolveConfig(input: AuthConfig): ResolvedConfig {
  if (input.secret.length < 32) throw new ConfigError("secret must be at least 32 characters");
  let origin: URL;
  try {
    origin = new URL(input.baseURL);
  } catch {
    throw new ConfigError("baseURL must be an absolute URL");
  }
  if (origin.pathname !== "/" || input.baseURL.endsWith("/") || origin.search || origin.hash) {
    throw new ConfigError("baseURL must be an origin with no path and no trailing slash");
  }
  for (const o of input.trustedOrigins) {
    if (o.includes("*")) throw new ConfigError(`trustedOrigins has a wildcard: ${o}`);
  }
  const basePath = input.basePath ?? "/auth";
  if (!basePath.startsWith("/") || basePath.endsWith("/")) {
    throw new ConfigError("basePath must start with / and not end with /");
  }
  const clock = input.clock ?? systemClock;
  return {
    basePath,
    baseURL: input.baseURL,
    secret: input.secret,
    trustedOrigins: new Set(input.trustedOrigins),
    storage: input.storage,
    mail: input.mail,
    limiter: input.limiter ?? createMemoryLimiter(clock),
    clientIp: input.clientIp ?? workersClientIp,
    clock,
    cookieName: input.cookieName ?? "tempo_session",
    session: {
      ttlDays: input.session?.ttlDays ?? 30,
      slidingRefreshDays: input.session?.slidingRefreshDays ?? 7,
    },
    magicLink: {
      ttlMinutes: input.magicLink?.ttlMinutes ?? 15,
      linkBuilder:
        input.magicLink?.linkBuilder ??
        ((token) =>
          `${input.baseURL}${basePath}/magic-link/verify?token=${encodeURIComponent(token)}`),
    },
  };
}
