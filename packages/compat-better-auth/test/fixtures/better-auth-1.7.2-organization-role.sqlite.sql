-- Better Auth 1.7.2's own SQL for its organizationRole table on SQLite, the
-- table of dynamicAccessControl. Produced on 2026-10-21 by
-- getMigrations(options).compileMigrations() of better-auth 1.7.2
-- (dist/db/get-migration.mjs), plugin organization({ ac, dynamicAccessControl:
-- { enabled: true } }), on a node:sqlite DatabaseSync in memory. The lines of
-- this table only; apply it after better-auth-1.7.2.sqlite.sql. A recorded
-- literal: Better Auth is not a dependency.
create table "organizationRole" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "role" text not null, "permission" text not null, "createdAt" date not null, "updatedAt" date);
create index "organizationRole_organizationId_idx" on "organizationRole" ("organizationId");
create index "organizationRole_role_idx" on "organizationRole" ("role");
