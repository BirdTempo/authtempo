-- @better-auth/api-key 1.7.5's own SQL for the apikey table on SQLite.
-- Produced on 2026-10-21 by getMigrations(options).compileMigrations() of
-- better-auth 1.7.5 (dist/db/get-migration.mjs), plugin apiKey({
-- defaultPrefix: "laaa_" }), on a node:sqlite DatabaseSync in memory. The
-- lines of this table only; apply it after better-auth-1.7.2.sqlite.sql. A
-- recorded literal: Better Auth is not a dependency (script
-- plan-12k-task-12-ddl.mjs).
create table "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" date, "enabled" integer, "rateLimitEnabled" integer, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" date, "expiresAt" date, "createdAt" date not null, "updatedAt" date not null, "permissions" text, "metadata" text);
create index "apikey_configId_idx" on "apikey" ("configId");
create index "apikey_referenceId_idx" on "apikey" ("referenceId");
create index "apikey_key_idx" on "apikey" ("key");
