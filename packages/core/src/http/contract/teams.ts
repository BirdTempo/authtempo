import { z } from "zod";
import type { RouteKey } from "../route-list.js";
import { id } from "./organizations.js";
import { OkAnswer, SessionAnswer } from "./shapes.js";
import type { RouteContract } from "./types.js";

/** The organization name rule bounds a team name; the engine checks the control characters. */
const name = z.string().min(1).max(120);

// Strict: a key of Better Auth's team routes, such as `data` on an update, answers invalid_body.
export const teamCreateBody = z.strictObject({ organizationId: id, name });
export const teamUpdateBody = z.strictObject({ teamId: id, name });
export const teamBody = z.strictObject({ teamId: id });
export const teamMemberBody = z.strictObject({ teamId: id, userId: id });
export const teamActiveBody = z.strictObject({ teamId: id.nullable() });

/** The query of the team list: the route reads `organizationId` by hand and parses it with `id`. */
export const teamListQuery = z.object({ organizationId: id });
/** The query of the members list: the route reads `teamId` by hand and parses it with `id`. */
export const teamMembersQuery = z.object({ teamId: id });

/** One team, as `TeamSummary` answers it. */
export const TeamJson = z.strictObject({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** One member of a team, as `TeamMemberSummary` answers it. */
export const TeamMemberJson = z.strictObject({
  id: z.string(),
  teamId: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const teamAnswer = z.strictObject({ team: TeamJson });
const teamsAnswer = z.strictObject({ teams: z.array(TeamJson) });
const jsonBody = <T extends z.ZodType>(schema: T) =>
  ({ schema, media: ["json"], parsedBy: "zod" }) as const;

/** The contract of `routes/teams.ts` (plan 12k Task 5). */
export const TEAMS_CONTRACT = {
  "GET /organizations/teams": {
    query: { schema: teamListQuery, parsedBy: "hand" },
    answer: { kind: "json", schema: teamsAnswer },
  },
  "POST /organizations/teams/create": {
    body: jsonBody(teamCreateBody),
    answer: { kind: "json", schema: teamAnswer },
  },
  "POST /organizations/teams/update": {
    body: jsonBody(teamUpdateBody),
    answer: { kind: "json", schema: teamAnswer },
  },
  "POST /organizations/teams/delete": {
    body: jsonBody(teamBody),
    answer: { kind: "json", schema: OkAnswer },
  },
  "GET /organizations/teams/members": {
    query: { schema: teamMembersQuery, parsedBy: "hand" },
    answer: { kind: "json", schema: z.strictObject({ members: z.array(TeamMemberJson) }) },
  },
  "POST /organizations/teams/members/add": {
    body: jsonBody(teamMemberBody),
    answer: { kind: "json", schema: z.strictObject({ member: TeamMemberJson }) },
  },
  "POST /organizations/teams/members/remove": {
    body: jsonBody(teamMemberBody),
    answer: { kind: "json", schema: OkAnswer },
  },
  "POST /organizations/teams/active": {
    body: jsonBody(teamActiveBody),
    // The session with its new active team, as `publicSession` answers it.
    answer: { kind: "json", schema: SessionAnswer },
  },
  "GET /organizations/teams/mine": { answer: { kind: "json", schema: teamsAnswer } },
} as const satisfies Partial<Record<RouteKey, RouteContract>>;
