import { browserWebAuthn, type Client, createClient } from "../client/index.js";
import { cutTokens } from "./cut.js";

/** Writes the print of the last call. textContent only, so an answer is never markup. */
function show(text: string): void {
  const out = document.getElementById("exchange");
  if (out !== null) out.textContent = text;
}

/** The fetch of the client: it prints the method, the path, the status, and the JSON answer of each call. */
async function recorded(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const res = await fetch(request);
  const json = (res.headers.get("content-type") ?? "").includes("application/json");
  const answer = json
    ? JSON.stringify(cutTokens(await res.clone().json()), null, 2)
    : "No JSON answer.";
  // The path only: a query can hold a token.
  show(`${request.method} ${new URL(request.url).pathname} ${res.status}\n${answer}`);
  return res;
}

/** The client of the demo pages. basePath is /auth, the default. */
export const client: Client = createClient({
  baseURL: location.origin,
  fetch: recorded,
  webauthn: browserWebAuthn(),
});

export type Run = (form: FormData) => Promise<unknown>;

/** The text of one field, or "" when the form has no such field. */
export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** The trimmed text of an optional field, or undefined when it is empty. */
export function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name).trim();
  return value === "" ? undefined : value;
}

/** The two calls of each method page: the session block of the layout. */
const COMMON: Readonly<Record<string, Run>> = {
  session: () => client.session(),
  "sign-out": () => client.signOut(),
};

/**
 * Binds each form[data-call] of the page to its call. A form with no call,
 * or a call with no form, throws, so a page and its script cannot drift.
 */
export function bind(runs: Readonly<Record<string, Run>>): void {
  const all: Record<string, Run> = { ...COMMON, ...runs };
  const bound = new Set<string>();
  for (const form of document.querySelectorAll<HTMLFormElement>("form[data-call]")) {
    const name = form.dataset.call ?? "";
    const run = all[name];
    if (run === undefined) throw new Error(`demo: no call for the form ${name}`);
    bound.add(name);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(new FormData(form)).catch((error: unknown) => show(`The call stopped: ${String(error)}`));
    });
  }
  for (const name of Object.keys(all))
    if (!bound.has(name)) throw new Error(`demo: no form for the call ${name}`);
}
