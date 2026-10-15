import { builtinEnvironments, type Environment } from "vitest/runtime";

/**
 * happy-dom for the DOM, with the runtime's fetch classes kept (plan 11d).
 * Vitest's happy-dom environment puts happy-dom's Request, Response, Headers,
 * and fetch on the global. happy-dom's Response drops Set-Cookie, as a browser
 * does, so core in process could not set its session cookie. Core and the
 * test's fetch run on the server side, so they keep the runtime's classes.
 * Other suites use this file too: packages/vue, packages/solid,
 * packages/sveltekit, packages/sdk-conformance, examples/react, examples/next,
 * and examples/solid. A change here changes each of their suites.
 */
const KEEP = [
  "Request",
  "Response",
  "Headers",
  "fetch",
  "FormData",
  "AbortController",
  "AbortSignal",
  "URL",
  "URLSearchParams",
] as const;

export default {
  name: "happy-dom-runtime-fetch",
  viteEnvironment: "client",
  async setup(global, options) {
    const kept = Object.fromEntries(KEEP.map((k) => [k, global[k]]));
    const env = await builtinEnvironments["happy-dom"].setup(global, options);
    Object.assign(global, kept);
    return env;
  },
} satisfies Environment;
