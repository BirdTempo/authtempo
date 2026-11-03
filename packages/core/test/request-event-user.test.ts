import { describe, expect, it } from "vitest";
import type { AuthEvent } from "../src/observe/port.js";
import { post, recordCredential, tokenFromMail } from "./helpers.js";
import { observed } from "./observe-helpers.js";

// Plan 12n decision 17 (spec 31): the `request` event names the user of the
// session that the handler resolved for that request. It names no user when
// no session resolved. So an operator ties a refusal of a route to an account.
// The mark is in `sessionFromRequest`, so each route here reads its session through it.

type Observed = ReturnType<typeof observed>;

/** The request events of the answer `res`, by its trace id. */
const requestsOf = (events: AuthEvent[], res: Response) =>
  events.filter((e) => e.name === "request" && e.traceId === res.headers.get("x-authtempo-trace"));

/** A magic link sign-in of `email` through the routes: the session cookie and the user id. */
async function signedIn(s: Observed, email: string) {
  await s.auth.handle(post("/auth/magic-link/request", { email }));
  const link = tokenFromMail(s.mail.at(-1)?.text ?? "");
  const res = await s.auth.handle(post("/auth/magic-link/verify", { token: link }));
  expect(res.status).toBe(200);
  const line = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tempo_session="));
  const token = line?.split(";")[0]?.split("=")[1];
  if (!token) throw new Error("the sign-in set no session cookie");
  const user = await s.storage.findOne("user", [{ field: "email", op: "eq", value: email }]);
  if (!user) throw new Error("the sign-in made no user");
  return { cookie: `__Host-tempo_session=${recordCredential(token)}`, userId: user.id };
}

describe("the user of the request event (plan 12n decision 17)", () => {
  it("names the user of the session of a signed-in write, on a success and on a refusal", async () => {
    const s = observed();
    const ada = await signedIn(s, "ada@example.com");
    const ended = await s.auth.handle(
      post("/auth/sessions/revoke-others", {}, { cookie: ada.cookie }),
    );
    expect(ended.status).toBe(200);
    // The session resolves before the body read, so the 400 of the body names Ada too.
    const refused = await s.auth.handle(post("/auth/sessions/revoke", {}, { cookie: ada.cookie }));
    expect([refused.status, await refused.json()]).toEqual([400, { error: "invalid_body" }]);
    const events = await s.events();
    expect(requestsOf(events, ended)).toMatchObject([
      { route: "POST /sessions/revoke-others", status: 200, userId: ada.userId },
    ]);
    expect(requestsOf(events, refused)).toMatchObject([
      { route: "POST /sessions/revoke", status: 400, code: "invalid_body", userId: ada.userId },
    ]);
  });

  it("names no user of an anonymous write, or of a write whose session does not resolve", async () => {
    const s = observed();
    const anonymous = await s.auth.handle(
      post("/auth/magic-link/request", { email: "bo@example.com" }),
    );
    expect(anonymous.status).toBe(200);
    // A cookie whose token names no session: the handler resolves none.
    const unknown = await s.auth.handle(
      post(
        "/auth/sessions/revoke-others",
        {},
        { cookie: `__Host-tempo_session=${recordCredential("x".repeat(43))}` },
      ),
    );
    expect(unknown.status).toBe(401);
    const events = await s.events();
    const [a, u] = [requestsOf(events, anonymous), requestsOf(events, unknown)];
    expect(a).toMatchObject([{ route: "POST /magic-link/request", status: 200 }]);
    expect(u).toMatchObject([
      { route: "POST /sessions/revoke-others", status: 401, code: "unauthorized" },
    ]);
    expect(a[0]).not.toHaveProperty("userId");
    expect(u[0]).not.toHaveProperty("userId");
  });
});
