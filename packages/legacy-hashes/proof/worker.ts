import { createPbkdf2PasswordHash } from "@authtempo/core";
import { createLegacyPasswordHash, LEGACY_FORMATS } from "../src/index.js";
import { FIREBASE, VECTORS } from "../test/vectors.js";

/**
 * The no-Node proof (plan 9b). proof/no-node.mjs starts this Worker in
 * workerd through wrangler with Node.js compatibility off, and reads the
 * answer. Every vector must verify, every wrong password must fail, and the
 * Worker must see no `process` global, which shows that the flags held.
 */
export default {
  async fetch(): Promise<Response> {
    const seam = createLegacyPasswordHash({
      formats: LEGACY_FORMATS,
      firebase: FIREBASE,
      next: createPbkdf2PasswordHash({ iterations: 1000 }),
    });
    const results: Record<string, { right: boolean; wrong: boolean }> = {};
    for (const [name, v] of Object.entries(VECTORS)) {
      results[name] = {
        right: (await seam.verify(v.password, v.stored)).ok,
        wrong: (await seam.verify(v.wrong, v.stored)).ok,
      };
    }
    const g = globalThis as Record<string, unknown>;
    return Response.json({
      process: typeof g.process,
      Buffer: typeof g.Buffer,
      expected: Object.keys(VECTORS).length,
      results,
    });
  },
};
