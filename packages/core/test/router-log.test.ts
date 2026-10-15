import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { BASE_URL, post } from "./helpers.js";
import { totpAuth, verifiedSession } from "./totp-helpers.js";

/**
 * The log line of an unhandled error (plan 12a Task 3 review M8). The app
 * sets an error's name, so the name is app data: a mail builder that throws
 * with the code in its name must not put the code in the log. The router
 * logs `appErrorName`.
 */

const leak = () => Object.assign(new Error("boom"), { name: "leak 123456" });

/** Every argument of every console.error call, as one text. */
function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the router's log line of an unhandled error (plan 12a)", () => {
  it("logs the filtered name of a route's throw, not the app's name", async () => {
    const auth = totpAuth();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = createRouter(auth.config, [
      {
        method: "POST",
        path: "/boom",
        handler: () => Promise.reject(leak()),
      },
    ]);
    const res = await handle(post("/auth/boom", {}));
    expect(res.status).toBe(500);
    expect(logged(spy)).toContain("Error");
    expect(logged(spy)).not.toContain("123456");
  });

  it("logs the filtered name of a preflight's throw, not the app's name", async () => {
    const auth = totpAuth();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = createRouter(auth.config, [
      {
        method: "POST",
        path: "/boom",
        handler: () => Promise.resolve(new Response(null, { status: 204 })),
        preflight: () => Promise.reject(leak()),
      },
    ]);
    const res = await handle(
      new Request(`${BASE_URL}/auth/boom`, {
        method: "OPTIONS",
        headers: { origin: "https://other.example" },
      }),
    );
    expect(res.status).toBe(500);
    expect(logged(spy)).toContain("Error");
    expect(logged(spy)).not.toContain("123456");
  });

  it("keeps the live code of a throwing account.mail out of the log", async () => {
    let code = "";
    const auth = totpAuth({
      account: {
        mail: (input) => {
          code = input.kind === "reauth_code" ? input.code : "";
          throw Object.assign(new Error("boom"), { name: `leak ${code}` });
        },
      },
    });
    const { token } = await verifiedSession(auth);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const res = await handle(post("/auth/reauth/email", {}, { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(500);
    expect(code).toMatch(/^\d{6}$/);
    expect(logged(spy)).not.toContain(code);
  });
});
