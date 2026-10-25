import { describe, expect, it } from "vitest";
import { harness } from "../support/harness.ts";
import { createRelatedOriginsAuth } from "./related-origins.ts";

describe("passkey related origins", () => {
  it("lists the origins outside the RP ID on the RP ID host", async () => {
    const auth = createRelatedOriginsAuth(harness());
    // Mount auth.wellKnown at the origin root of example.com.
    const res = await auth.wellKnown(new Request("https://example.com/.well-known/webauthn"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ origins: ["https://example.net", "https://example.org"] });
  });

  it("answers 404 on any other host", async () => {
    const auth = createRelatedOriginsAuth(harness());
    const res = await auth.wellKnown(new Request("https://api.example.com/.well-known/webauthn"));
    expect(res.status).toBe(404);
  });
});
