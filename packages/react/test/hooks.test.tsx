import { createClient } from "@authtempo/client";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuthError, useClient, useSession } from "../src/index.js";
import { API, browserFetch, linkToken, makeServer } from "./support.js";

function Probe() {
  const { data, error, isPending } = useSession();
  if (isPending) return <p>pending</p>;
  if (error) return <p>error:{error.code}</p>;
  return <p>{data ? data.user.email : "signed out"}</p>;
}

function mount(node: ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  root.render(node);
  return { el, unmount: () => root.unmount() };
}

describe("@authtempo/react (plan 11d)", () => {
  it("keeps the runtime's fetch classes under the DOM library", () => {
    // core's harness reads Set-Cookie lines with getSetCookie; a DOM Headers without it breaks every flow.
    expect(typeof new Headers().getSetCookie).toBe("function");
    // happy-dom's Response drops Set-Cookie, as a browser does; core in process needs the runtime's.
    const res = new Response(null, { headers: { "set-cookie": "a=b; Path=/" } });
    expect(res.headers.getSetCookie()).toEqual(["a=b; Path=/"]);
  });

  it("throws a clear error when no AuthProvider is above a hook", () => {
    expect(() => renderToString(<Probe />)).toThrow(/AuthProvider/);
  });

  it("renders the pending state on the server, and reads nothing there", () => {
    let reads = 0;
    const client = createClient({
      baseURL: API,
      fetch: (async () => {
        reads++;
        return Response.json({});
      }) as typeof fetch,
    });
    expect(
      renderToString(
        <AuthProvider client={client}>
          <Probe />
        </AuthProvider>,
      ),
    ).toBe("<p>pending</p>");
    expect(reads).toBe(0);
  });

  it("shows the session after the first read, after a sign-in, and after a sign-out", async () => {
    const server = makeServer();
    const client = createClient({ baseURL: API, fetch: browserFetch(server.auth) });
    const view = mount(
      <AuthProvider client={client}>
        <Probe />
      </AuthProvider>,
    );
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
    const view = mount(
      <AuthProvider client={client}>
        <Probe />
      </AuthProvider>,
    );
    await vi.waitFor(() => expect(view.el.textContent).toBe("error:network"));
    view.unmount();
  });

  it("gives refetch and the client to a component", async () => {
    const server = makeServer();
    const client = createClient({ baseURL: API, fetch: browserFetch(server.auth) });
    let seen: { refetch?: () => Promise<void>; same?: boolean } = {};
    function Grab() {
      const s = useSession();
      seen = { refetch: s.refetch, same: useClient() === client };
      return null;
    }
    const view = mount(
      <AuthProvider client={client}>
        <Grab />
      </AuthProvider>,
    );
    await vi.waitFor(() => expect(seen.same).toBe(true));
    expect(seen.refetch).toBe(client.store.refetch);
    view.unmount();
  });

  it("reads the redirect error of the URL once, from the location or from an argument", async () => {
    const client = createClient({ baseURL: API, fetch: browserFetch(makeServer().auth) });
    history.replaceState(null, "", "/?auth_error=oauth_denied");
    function Err(props: { url?: string }) {
      const code = useAuthError(props.url);
      return <p>{code ?? "none"}</p>;
    }
    const view = mount(
      <AuthProvider client={client}>
        <Err />
        <Err url="https://app.example.com/?auth_error=brand_new" />
        <Err url="https://app.example.com/home" />
      </AuthProvider>,
    );
    await vi.waitFor(() => expect(view.el.textContent).toBe("oauth_deniedunexpectednone"));
    history.replaceState(null, "", "/");
    view.unmount();
  });
});
