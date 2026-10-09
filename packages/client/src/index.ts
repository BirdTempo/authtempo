export { ERRORS, type ErrorCode } from "@tempo-auth/core/errors";
export { type Client, type ClientOptions, createClient } from "./client.js";
export type { ClientCode, ClientFailure, ClientResult } from "./result.js";
export { type Call, createTransport, type TransportOptions } from "./transport.js";
