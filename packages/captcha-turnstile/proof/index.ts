import { createTurnstileCaptcha } from "../src/index.js";

// The bundle proof of plan 12b: wrangler bundles this Worker with
// no_nodejs_compat, and bundle-no-node.mjs fails on a node: import.
export default {
  async fetch(): Promise<Response> {
    const port = createTurnstileCaptcha({ secretKey: "1x0000000000000000000000000000000AA" });
    return Response.json({ page: port.page ?? null });
  },
};
