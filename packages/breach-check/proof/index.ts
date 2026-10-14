import { createBreachCheck } from "../src/index.js";

// The bundle proof of plan 12b: wrangler bundles this Worker with
// no_nodejs_compat, and bundle-no-node.mjs fails on a node: import.
export default {
  async fetch(): Promise<Response> {
    const check = createBreachCheck({ fetch: async () => new Response("", { status: 200 }) });
    return Response.json({ breached: await check("probe") });
  },
};
