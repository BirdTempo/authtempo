import { createAuth } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { API, harness, signIn } from "../support/harness.ts";
import { createFetchHandler } from "./other-stacks.ts";

// Bun builds request.url from the Host header. A Host that does not parse ("a b")
// gives the path only, as this request does.
class PathOnlyRequest extends Request {
  override get url() {
    return new URL(super.url).pathname;
  }
}

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

  it("answers no 500 for a request whose URL is a path only: the origin of baseURL", async () => {
    const h = harness();
    const auth = createAuth({
      baseURL: API,
      trustedOrigins: [],
      secret: h.secret,
      storage: h.storage,
      mail: h.mail,
    });
    const fetch = createFetchHandler(auth);
    expect((await fetch(new PathOnlyRequest(`${API}/me`))).status).toBe(401);
    expect((await fetch(new PathOnlyRequest(`${API}/auth/session`))).status).toBe(401);
    // A path that starts with "//" stays a path on the origin of baseURL: no route of core.
    const twoSlashes = new PathOnlyRequest(`${API}//evil.example/auth/session`, {
      headers: { host: "a b" },
    });
    expect((await fetch(twoSlashes)).status).toBe(404);
  });
});
