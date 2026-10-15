import { type Client, createClient } from "@authtempo/client";
import { createComponent, type JSX } from "solid-js";
import html from "solid-js/html";
import { isServer, render } from "solid-js/web";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuthError, useClient, useSession } from "../src/index.js";
import { API, browserFetch, linkToken, makeServer } from "./support.js";

function Probe(): JSX.Element {
  const { session } = useSession();
  return html`<p>${() => {
    const s = session();
    if (s.isPending) return "pending";
    if (s.error) return `error:${s.error.code}`;
    return s.data ? s.data.user.email : "signed out";
  }}</p>`;
}

function mount(client: Client, component: () => JSX.Element = Probe) {
  const el = document.createElement("div");
  document.body.append(el);
  const dispose = render(
    () =>
      createComponent(AuthProvider, {
        client,
        get children() {
          return createComponent(component, {});
        },
      }),
    el,
  );
  return { el, unmount: dispose };
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

describe("@authtempo/solid (plan 11d2)", () => {
  it("runs the browser build of solid-js, and keeps the runtime's fetch classes", () => {
    // The server build has no reactivity. If this fails, the vitest config
    // does not reach the browser build.
    expect(isServer).toBe(false);
    // happy-dom's Response drops Set-Cookie, as a browser does; core in process needs the runtime's.
    const res = new Response(null, { headers: { "set-cookie": "a=b; Path=/" } });
    expect(res.headers.getSetCookie()).toEqual(["a=b; Path=/"]);
  });

  it("throws a clear error when no AuthProvider is above a primitive", () => {
    const el = document.createElement("div");
    expect(() =>
      render(() => {
        useClient();
        return null;
      }, el),
    ).toThrow(/AuthProvider/);
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
    const view = mount(client, () => {
      const s = useSession();
      seen = { refetch: s.refetch, same: useClient() === client };
      return null;
    });
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
    const view = mount(client, () => {
      const code = useAuthError("https://app.example.com/?auth_error=oauth_denied");
      const none = useAuthError("https://app.example.com/home");
      return html`<p>${`${code}:${none}`}</p>`;
    });
    expect(view.el.textContent).toBe("oauth_denied:null");
    view.unmount();
  });
});
