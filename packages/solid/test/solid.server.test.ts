import { type Client, createClient } from "@authtempo/client";
import { createComponent, type JSX } from "solid-js";
import { isServer, renderToString } from "solid-js/web";
import { describe, expect, it } from "vitest";
import { AuthProvider, useSession } from "../src/index.js";
import { API, browserFetch, makeServer } from "./support.js";

function Probe(): JSX.Element {
  const { session } = useSession();
  const s = session();
  if (s.isPending) return "pending";
  return s.data ? s.data.user.email : "signed out";
}

describe("@authtempo/solid on the server (plan 11d2)", () => {
  it("shows the pending state in a server render, and starts no read", async () => {
    // The server build of solid-js, as a Solid Start render loads it.
    expect(isServer).toBe(true);
    const inner = browserFetch(makeServer().auth);
    const count = { subscribes: 0, fetches: 0 };
    const base = createClient({
      baseURL: API,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        count.fetches++;
        return inner(input, init);
      }) as typeof fetch,
    });
    // One client for every render, as a module-level client of an app.
    const client: Client = {
      ...base,
      store: {
        ...base.store,
        subscribe(listener) {
          count.subscribes++;
          return base.store.subscribe(listener);
        },
      },
    };
    const render = () =>
      renderToString(() =>
        createComponent(AuthProvider, {
          client,
          get children() {
            return createComponent(Probe, {});
          },
        }),
      );
    expect(render()).toBe("pending");
    // A second render must not show the answer of a read that the first started.
    await new Promise((done) => setTimeout(done, 20));
    expect(render()).toBe("pending");
    expect(count).toEqual({ subscribes: 0, fetches: 0 });
  });
});
