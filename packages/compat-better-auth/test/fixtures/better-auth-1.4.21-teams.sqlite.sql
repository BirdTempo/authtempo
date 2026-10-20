-- The team and teamMember tables of Better Auth 1.4.21's teams option, on
-- SQLite. Version 1.4.21 has no team.memberCount and no
-- teamMember.membershipKey; Better Auth 1.7.2 has both. The field list is
-- the one of 1.4.21 (dist/plugins/organization/organization.mjs:144 to :207,
-- read from the pnpm store on 2026-10-21). The getMigrations generator of
-- better-auth 1.7.2 compiled it on a node:sqlite DatabaseSync in memory.
-- Script: plan-12k-task-11fix-ddl1421.mjs. Apply it after
-- better-auth-1.7.2.sqlite.sql. A recorded literal: Better Auth is not a
-- dependency.
create table "team" ("id" text not null primary key, "name" text not null, "organizationId" text not null references "organization" ("id") on delete cascade, "createdAt" date not null, "updatedAt" date);
create table "teamMember" ("id" text not null primary key, "teamId" text not null references "team" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "createdAt" date);
create index "team_organizationId_idx" on "team" ("organizationId");
create index "teamMember_teamId_idx" on "teamMember" ("teamId");
create index "teamMember_userId_idx" on "teamMember" ("userId");
