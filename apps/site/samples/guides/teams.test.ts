import { describe, expect, it } from "vitest";
import { call, harness, signIn } from "../support/harness.ts";
import { createTeamsAuth } from "./teams.ts";

describe("teams", () => {
  it("a member removal leaves no team row", async () => {
    const h = harness();
    const auth = createTeamsAuth(h);
    const ada = await signIn(auth, h, "ada@example.com");
    const bo = await signIn(auth, h, "bo@example.com");
    const boUser = (
      (await (await call(auth, "GET", "/auth/session", undefined, { cookie: bo })).json()) as {
        user: { id: string };
      }
    ).user;
    const created = await call(
      auth,
      "POST",
      "/auth/organizations/create",
      { slug: "acme", name: "Acme" },
      { cookie: ada },
    );
    const { organization } = (await created.json()) as { organization: { id: string } };
    const organizationId = organization.id;
    await call(
      auth,
      "POST",
      "/auth/organizations/members/add",
      { organizationId, userId: boUser.id, role: "member" },
      { cookie: ada },
    );

    // defaultTeam made the team "Acme" with Ada in it. Ada makes a second team and adds Bo to both.
    const team = await call(
      auth,
      "POST",
      "/auth/organizations/teams/create",
      { organizationId, name: "Design" },
      { cookie: ada },
    );
    expect(team.status).toBe(200);
    const teams = (
      (await (
        await call(
          auth,
          "GET",
          `/auth/organizations/teams?organizationId=${organizationId}`,
          undefined,
          {
            cookie: ada,
          },
        )
      ).json()) as { teams: { id: string; name: string }[] }
    ).teams;
    expect(teams.map((t) => t.name)).toEqual(["Acme", "Design"]);
    for (const t of teams) {
      const add = await call(
        auth,
        "POST",
        "/auth/organizations/teams/members/add",
        { teamId: t.id, userId: boUser.id },
        { cookie: ada },
      );
      expect(add.status).toBe(200);
    }
    expect(
      await h.storage.findMany("teamMember", [{ field: "userId", op: "eq", value: boUser.id }]),
    ).toHaveLength(2);

    // The removal from the organization deletes Bo's team rows in the same write.
    const removed = await call(
      auth,
      "POST",
      "/auth/organizations/members/remove",
      { organizationId, userId: boUser.id },
      { cookie: ada },
    );
    expect(removed.status).toBe(200);
    expect(
      await h.storage.findMany("teamMember", [{ field: "userId", op: "eq", value: boUser.id }]),
    ).toEqual([]);
    const mine = await call(auth, "GET", "/auth/organizations/teams/mine", undefined, {
      cookie: bo,
    });
    expect(await mine.json()).toEqual({ teams: [] });
  });
});
