export const VERSION = "0.0.0";

export type { AuthConfig, MailMessage, MailPort } from "./config.js";
export { ConfigError } from "./config.js";
export { type Auth, type AuthApi, createAuth } from "./create-auth.js";
export type { MagicLinkRequest, MagicLinkVerify } from "./engine/magic-link.js";
export type { ResolvedSession } from "./engine/sessions.js";
export { ERRORS, type ErrorCode } from "./errors.js";
export { createMemoryLimiter } from "./limiter/memory.js";
export type { LimiterPort, LimitWindow } from "./limiter/port.js";
export type { Clock } from "./primitives/clock.js";
export type { Result } from "./result.js";
export {
  type IdentityRow,
  type ModelName,
  type Models,
  type PasskeyRow,
  SCHEMA_VERSION,
  type SessionRow,
  schema,
  type UserRow,
  type VerificationRow,
} from "./schema.js";
export { createMemoryAdapter } from "./storage/memory.js";
export {
  type FindManyOptions,
  type Op,
  type Sort,
  type StorageAdapter,
  StorageError,
  type Where,
} from "./storage/port.js";
