import { createAuth } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { API, harness, signIn } from "../support/harness.ts";
import { createFetchHandler } from "./other-stacks.ts";

describe("mount authtempo on any other stack", () => {
  it("serves core, the well-known documents, and an app route from one fetch handler", async () => {
    const h = harness();
    const auth = createAuth({
      baseURL: API,
      trustedOrigins: [],
      secret: h.secret,
      storage: h.storage,
      mail: h.mail,
    });
    const fetch = createFetchHandler(auth);
    expect((await fetch(new Request(`${API}/auth/session`))).status).toBe(401);
    expect((await fetch(new Request(`${API}/me`))).status).toBe(401);
    const cookie = await signIn(auth, h, "ada@example.com");
    const me = await fetch(new Request(`${API}/me`, { headers: { cookie } }));
    expect(await me.json()).toEqual({ email: "ada@example.com" });
    expect((await fetch(new Request(`${API}/other`))).status).toBe(404);
  });

  it("matches the raw path: an escape, another case, or a trailing slash reaches no page", async () => {
    const h = harness();
    const auth = createAuth({
      baseURL: API,
      trustedOrigins: [],
      secret: h.secret,
      storage: h.storage,
      mail: h.mail,
    });
    const fetch = createFetchHandler(auth);
    const cookie = await signIn(auth, h, "ada@example.com");
    for (const path of ["/%6De", "/ME", "/me/", "/%61uth/session"]) {
      const res = await fetch(new Request(`${API}${path}`, { headers: { cookie } }));
      expect(res.status, path).toBe(404);
    }
  });
});
