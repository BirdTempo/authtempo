import { describe, expect, it } from "vitest";
import { call, harness, linkIn } from "../support/harness.ts";
import { createPagesAuth } from "./pages.ts";

describe("replace the default pages", () => {
  it("serves the app's confirm page with core's headers", async () => {
    const h = harness();
    const auth = createPagesAuth(h);
    await call(auth, "POST", "/auth/magic-link/request", { email: "ada@example.com" });
    const page = await auth.handle(new Request(linkIn(h, "ada@example.com")));
    expect(await page.text()).toContain('<button type="submit">Continue to Example</button>');
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("form-action");
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
  });
});
