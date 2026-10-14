import { createClient, errorText } from "@authtempo/client";
import { type Auth, createAuth, createMemoryAdapter, type MailMessage } from "@authtempo/core";
import { AuthProvider } from "@authtempo/react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";

const API = "https://api.example.com";
const APP = "https://app.example.com";

function server(): { auth: Auth; mail: MailMessage[] } {
  const mail: MailMessage[] = [];
  const auth = createAuth({
    baseURL: API,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
  });
  return { auth, mail };
}

/** The browser: the page's Origin and one cookie jar, to core in process. */
function browser(auth: Auth): typeof fetch {
  const jar = new Map<string, string>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers = new Headers(req.headers);
    headers.set("origin", APP);
    if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await auth.handle(new Request(req, { headers }));
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const [name = "", value = ""] = pair.split("=");
      if (attrs.some((a) => a.trim() === "Max-Age=0") || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  }) as typeof fetch;
}

/** Types a value into a controlled input, as a person does: the native setter, then an input event. */
function type(input: Element | null, value: string): void {
  if (!(input instanceof HTMLInputElement)) throw new Error("no input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(el: Element, text: string): void {
  const button = [...el.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!button) throw new Error(`no button ${text}`);
  button.click();
}

function render(auth: Auth) {
  const client = createClient({ baseURL: API, fetch: browser(auth) });
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  root.render(
    <AuthProvider client={client}>
      <App />
    </AuthProvider>,
  );
  return { el, unmount: () => root.unmount() };
}

describe("the React example (plan 11d)", () => {
  it("signs a person in by email code, shows the session, and signs out", async () => {
    const s = server();
    const view = render(s.auth);
    await vi.waitFor(() => expect(view.el.querySelector('input[name="email"]')).not.toBeNull());
    type(view.el.querySelector('input[name="email"]'), "ada@example.com");
    press(view.el, "Send a code");
    await vi.waitFor(() => expect(view.el.querySelector('input[name="code"]')).not.toBeNull());
    const code = /\b(\d{6})\b/.exec(s.mail.at(-1)?.text ?? "")?.[1] ?? "";
    type(view.el.querySelector('input[name="code"]'), code);
    press(view.el, "Sign in");
    await vi.waitFor(() =>
      expect(view.el.querySelector('[data-testid="who"]')?.textContent).toBe("ada@example.com"),
    );
    press(view.el, "Sign out");
    await vi.waitFor(() => expect(view.el.querySelector('input[name="email"]')).not.toBeNull());
    view.unmount();
  });

  it("shows the text of a wrong code, and of the redirect error of the URL", async () => {
    const s = server();
    history.replaceState(null, "", "/?auth_error=oauth_denied");
    const view = render(s.auth);
    await vi.waitFor(() =>
      expect(view.el.querySelector('[role="alert"]')?.textContent).toBe(errorText("oauth_denied")),
    );
    type(view.el.querySelector('input[name="email"]'), "ada@example.com");
    press(view.el, "Send a code");
    await vi.waitFor(() => expect(view.el.querySelector('input[name="code"]')).not.toBeNull());
    type(view.el.querySelector('input[name="code"]'), "000000");
    press(view.el, "Sign in");
    await vi.waitFor(() =>
      expect([...view.el.querySelectorAll('[role="alert"]')].map((a) => a.textContent)).toContain(
        errorText("invalid_code"),
      ),
    );
    history.replaceState(null, "", "/");
    view.unmount();
  });
});
