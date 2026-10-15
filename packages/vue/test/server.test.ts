import { type Client, createClient } from "@authtempo/client";
import { describe, expect, it } from "vitest";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { authPlugin, useSession } from "../src/index.js";
import { API } from "./support.js";

// This file runs in the "server" project of vitest.config.ts: Node, no window.
const Probe = defineComponent({
  setup() {
    const { session } = useSession();
    return () => h("p", session.value.isPending ? "pending" : "read");
  },
});

describe("@authtempo/vue on the server (plan 11d2)", () => {
  it("renders the pending state on the server, and neither subscribes nor reads", async () => {
    expect(typeof window).toBe("undefined");
    let fetches = 0;
    let subscribes = 0;
    const client = createClient({
      baseURL: API,
      fetch: (async () => {
        fetches++;
        return Response.json({});
      }) as typeof fetch,
    });
    // One client for every render, as a module-level client of an app would be.
    const shared: Client = {
      ...client,
      store: {
        ...client.store,
        subscribe(listener) {
          subscribes++;
          return client.store.subscribe(listener);
        },
      },
    };
    for (let i = 0; i < 3; i++) {
      const html = await renderToString(createSSRApp(Probe).use(authPlugin(shared)));
      expect(html).toBe("<p>pending</p>");
    }
    await new Promise((done) => setTimeout(done, 20));
    expect(subscribes).toBe(0);
    expect(fetches).toBe(0);
    expect(client.store.get().isPending).toBe(true);
  });
});
