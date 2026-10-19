import { importUsers, readSource } from "@authtempo/import";
import { FIXTURE_EXPORTS } from "@authtempo/import/testing";
import { describe, expect, it } from "vitest";
import { call, harness, linkIn, sessionCookieOf } from "../support/harness.ts";
import { createWorkosAuth } from "./workos.ts";

// The fixture export of the WorkOS reader: Wren, verified, admin of Okafor Labs, and Theo.
const f = FIXTURE_EXPORTS.workos;
const WREN = "wren@example.com";

describe("move users from WorkOS", () => {
  it("imports a WorkOS export with no password, and signs the user in by a magic link", async () => {
    const h = harness();
    const report = await importUsers(h.storage, await readSource(f.bundle), { formats: [] });
    expect({
      passwords: report.created.password,
      organizations: report.created.organization,
    }).toEqual({ passwords: 0, organizations: 1 });

    const auth = createWorkosAuth(h);
    const request = await call(auth, "POST", "/auth/magic-link/request", { email: WREN });
    expect(request.status).toBe(200);
    const token = linkIn(h, WREN).searchParams.get("token") ?? "";
    const verify = await call(auth, "POST", "/auth/magic-link/verify", { token });
    expect(verify.status).toBe(200);
    const cookie = sessionCookieOf(verify);

    const session = await call(auth, "GET", "/auth/session", undefined, { cookie });
    expect(session.status).toBe(200);
    const { user } = (await session.json()) as { user: { email: string } };
    expect(user.email).toBe(WREN);
    // The first admin of a WorkOS organization becomes its owner.
    const orgs = await call(auth, "GET", "/auth/organizations", undefined, { cookie });
    const { organizations } = (await orgs.json()) as {
      organizations: { organization: { name: string }; role: string }[];
    };
    expect(organizations.map((o) => [o.organization.name, o.role])).toEqual([
      ["Okafor Labs", "owner"],
    ]);
  });

  it("lets an imported user set a password by a reset", async () => {
    const h = harness();
    await importUsers(h.storage, await readSource(f.bundle), { formats: [] });
    const auth = createWorkosAuth(h);
    const password = "a new password for wren";

    const request = await call(auth, "POST", "/auth/password/reset/request", { email: WREN });
    expect(request.status).toBe(200);
    const token = linkIn(h, WREN).searchParams.get("token") ?? "";
    const reset = await call(auth, "POST", "/auth/password/reset", { token, password });
    expect(reset.status).toBe(200);
    const signIn = await call(auth, "POST", "/auth/password/sign-in", { email: WREN, password });
    expect(signIn.status).toBe(200);
  });
});
