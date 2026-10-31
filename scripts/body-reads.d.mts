// The types of body-reads.mjs for the tests of core and compat-better-auth.
// Core's typecheck has no Node types and no TypeScript API types, so the
// compiler API is `unknown` here and the scan reads it as `any`.

/** The TypeScript compiler API, as `await import("typescript-api")` gives it. */
export type TypeScriptApi = unknown;

export declare const BODY_MEMBERS: readonly string[];

export declare function rawBodyReads(
  ts: TypeScriptApi,
  tsconfig: string,
  files?: string[],
): { files: number; reads: string[] };
