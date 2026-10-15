import { type Client, createClient } from "@authtempo/client";
import { describe, expect, it, vi } from "vitest";
import { type Component, createApp, defineComponent, h } from "vue";
import { authPlugin, useAuthError, useClient, useSession } from "../src/index.js";
import { API, browserFetch, linkToken, makeServer } from "./support.js";

const Probe = defineComponent({
  setup() {
    const { session } = useSession();
    return () => {
      const s = session.value;
      if (s.isPending) return h("p", "pending");
      if (s.error) return h("p", `error:${s.error.code}`);
      return h("p", s.data ? s.data.user.email : "signed out");
    };
  },
});

function mount(client: Client, component: Component = Probe) {
  const el = document.createElement("div");
  document.body.append(el);
  const app = createApp(component).use(authPlugin(client));
  app.mount(el);
  return { el, unmount: () => app.unmount() };
}

/** The client with a count of the live listeners of its store, and of the calls after `mute`. */
function counted(client: Client) {
  const count = { live: 0, late: 0, muted: false };
  const wrapped: Client = {
    ...client,
    store: {
      ...client.store,
      subscribe(listener) {
        count.live++;
        const stop = client.store.subscribe(() => {
          if (count.muted) count.late++;
          listener();
        });
        return () => {
          count.live--;
          stop();
        };
      },
    },
  };
  return { client: wrapped, count };
}

describe("@authtempo/vue (plan 11d2)", () => {
  it("keeps the runtime's fetch classes under the DOM library", () => {
    // happy-dom's Response drops Set-Cookie, as a browser does; core in process needs the runtime's.
    const res = new Response(null, { headers: { "set-cookie": "a=b; Path=/" } });
    expect(res.headers.getSetCookie()).toEqual(["a=b; Path=/"]);
  });

  it("throws a clear error when the plugin is not installed", () => {
    const app = createApp(
      defineComponent({
        setup() {
          useClient();
          return () => null;
        },
      }),
    );
    let thrown: unknown = null;
    app.config.errorHandler = (e) => {
      thrown = e;
    };
    app.mount(document.createElement("div"));
    expect(String(thrown)).toMatch(/authPlugin/);
    app.unmount();
  });

  it("shows the session after the first read, after a sign-in, and after a sign-out", async () => {
    const server = makeServer();
    const client = createClient({ baseURL: API, fetch: browserFetch(server.auth) });
    const view = mount(client);
    expect(view.el.textContent).toBe("pending");
    await vi.waitFor(() => expect(view.el.textContent).toBe("signed out"));
    await client.magicLink.request({ email: "ada@example.com" });
    await client.magicLink.verify({ token: linkToken(server.mail) });
    await vi.waitFor(() => expect(view.el.textContent).toBe("ada@example.com"));
    await client.signOut();
    await vi.waitFor(() => expect(view.el.textContent).toBe("signed out"));
    view.unmount();
  });

  it("shows the failure of a read in the error field", async () => {
    const client = createClient({
      baseURL: API,
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });
    const view = mount(client);
    await vi.waitFor(() => expect(view.el.textContent).toBe("error:network"));
    view.unmount();
  });

  it("gives refetch and the client to a component", () => {
    const client = createClient({ baseURL: API, fetch: browserFetch(makeServer().auth) });
    let seen: { refetch?: () => Promise<void>; same?: boolean } = {};
    const Grab = defineComponent({
      setup() {
        const s = useSession();
        seen = { refetch: s.refetch, same: useClient() === client };
        return () => null;
      },
    });
    const view = mount(client, Grab);
    expect(seen.same).toBe(true);
    expect(seen.refetch).toBe(client.store.refetch);
    view.unmount();
  });

  it("stops listening at the unmount", async () => {
    const { client, count } = counted(
      createClient({ baseURL: API, fetch: browserFetch(makeServer().auth) }),
    );
    const view = mount(client);
    await vi.waitFor(() => expect(view.el.textContent).toBe("signed out"));
    expect(count.live).toBe(1);
    view.unmount();
    expect(count.live).toBe(0);
  });

  it("stops listening at an unmount while a session read runs", async () => {
    const auth = makeServer().auth;
    const inner = browserFetch(auth);
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    // The first read waits until the test lets it go, so the unmount falls inside it.
    const base = createClient({
      baseURL: API,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        await gate;
        return inner(input, init);
      }) as typeof fetch,
    });
    const { client, count } = counted(base);
    const view = mount(client);
    expect(view.el.textContent).toBe("pending");
    view.unmount();
    expect(count.live).toBe(0);
    count.muted = true;
    release();
    await vi.waitFor(() => expect(base.store.get().isPending).toBe(false));
    expect(count.late).toBe(0);
    expect(view.el.textContent).toBe("");
  });

  it("reads the redirect error of the URL once", () => {
    const client = createClient({ baseURL: API, fetch: browserFetch(makeServer().auth) });
    const Err = defineComponent({
      setup() {
        const code = useAuthError("https://app.example.com/?auth_error=oauth_denied");
        const none = useAuthError("https://app.example.com/home");
        return () => h("p", `${code}:${none}`);
      },
    });
    const view = mount(client, Err);
    expect(view.el.textContent).toBe("oauth_denied:null");
    view.unmount();
  });
});
