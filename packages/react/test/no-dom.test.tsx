// @vitest-environment node
import { createClient } from "@authtempo/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

const API = "https://api.example.com";

/**
 * The binding with no DOM, as a server render or React Native runs it: no
 * window, no document, no location (plan 11d Task 10 review, L4).
 */
describe("@authtempo/react with no DOM", () => {
  it("loads, renders the pending state with no read, and answers null for the redirect error", async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    expect(typeof (globalThis as { location?: unknown }).location).toBe("undefined");
    const { AuthProvider, useAuthError, useSession } = await import("../src/index.js");
    let reads = 0;
    const client = createClient({
      baseURL: API,
      fetch: (async () => {
        reads++;
        return Response.json({});
      }) as typeof fetch,
    });
    function Page() {
      const { isPending } = useSession();
      const code = useAuthError();
      return (
        <p>
          {isPending ? "pending" : "read"}:{code ?? "none"}
        </p>
      );
    }
    const html = renderToString(
      <AuthProvider client={client}>
        <Page />
      </AuthProvider>,
    );
    expect(html).toBe("<p>pending<!-- -->:<!-- -->none</p>");
    expect(reads).toBe(0);
  });
});
