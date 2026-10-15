import { type Client, createClient } from "@authtempo/client";
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { sessionStore } from "../src/store.js";

// This file runs in the "server" project of vitest.config.ts: Node, no window,
// as a server render of SvelteKit. A component's `$session` subscribes there too.
describe("@authtempo/sveltekit/store on the server (plan 11d2)", () => {
  it("answers the pending state on the server, and neither subscribes nor reads", async () => {
    expect(typeof window).toBe("undefined");
    let fetches = 0;
    let subscribes = 0;
    const client = createClient({
      baseURL: "https://api.example.com",
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
    const session = sessionStore(shared);
    for (let i = 0; i < 3; i++) {
      expect(get(session).isPending).toBe(true);
      const seen: boolean[] = [];
      const stop = session.subscribe((s) => seen.push(s.isPending));
      stop();
      expect(seen).toEqual([true]);
    }
    await new Promise((done) => setTimeout(done, 20));
    expect(subscribes).toBe(0);
    expect(fetches).toBe(0);
    expect(client.store.get().isPending).toBe(true);
  });
});
