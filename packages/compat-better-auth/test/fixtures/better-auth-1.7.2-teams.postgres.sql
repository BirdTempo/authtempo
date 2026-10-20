-- Better Auth 1.7.2's own SQL for the team and teamMember tables on Postgres,
-- the tables of its teams option. Produced on 2026-10-21 by
-- getMigrations(options).compileMigrations() of better-auth 1.7.2
-- (dist/db/get-migration.mjs), plugin organization({ teams: { enabled: true }
-- }), on a pg 8.23.0 pool against an empty Postgres 17 database. The lines of
-- these two tables only; apply it after better-auth-1.7.2.postgres.sql. The
-- option also adds session.activeTeamId and invitation.teamId. A recorded
-- literal: Better Auth is not a dependency.
create table "team" ("id" text not null primary key, "name" text not null, "memberCount" integer not null, "organizationId" text not null references "organization" ("id") on delete cascade, "createdAt" timestamptz not null, "updatedAt" timestamptz);
create table "teamMember" ("id" text not null primary key, "teamId" text not null references "team" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "membershipKey" text unique, "createdAt" timestamptz);
create index "team_organizationId_idx" on "team" ("organizationId");
create index "teamMember_teamId_idx" on "teamMember" ("teamId");
create index "teamMember_userId_idx" on "teamMember" ("userId");
