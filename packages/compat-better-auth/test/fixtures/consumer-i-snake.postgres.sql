-- consumer-i's Better Auth tables as its Drizzle schema declares them
-- (packages/db/src/schema/auth.ts, read 2026-10-10): snake_case columns, no
-- "issuer" on account. The passkey table is added in the same casing, from
-- Better Auth 1.7.2's passkey schema. Written by hand, not generated.
create table "user" ("id" text primary key, "name" text not null, "email" text not null unique, "email_verified" boolean not null default false, "image" text, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now());
create table "session" ("id" text primary key, "expires_at" timestamptz not null, "token" text not null unique, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "ip_address" text, "user_agent" text, "user_id" text not null references "user" ("id") on delete cascade, "active_organization_id" text);
create index "session_user_id_idx" on "session" ("user_id");
create table "account" ("id" text primary key, "account_id" text not null, "provider_id" text not null, "user_id" text not null references "user" ("id") on delete cascade, "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" timestamptz, "refresh_token_expires_at" timestamptz, "scope" text, "password" text, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now());
create index "account_user_id_idx" on "account" ("user_id");
create table "verification" ("id" text primary key, "identifier" text not null, "value" text not null, "expires_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now());
create index "verification_identifier_idx" on "verification" ("identifier");
create table "organization" ("id" text primary key, "name" text not null, "slug" text not null unique, "logo" text, "created_at" timestamptz not null default now(), "metadata" text);
create table "member" ("id" text primary key, "organization_id" text not null references "organization" ("id") on delete cascade, "user_id" text not null references "user" ("id") on delete cascade, "role" text not null default 'member', "created_at" timestamptz not null default now());
create index "member_org_idx" on "member" ("organization_id");
create index "member_user_idx" on "member" ("user_id");
create table "invitation" ("id" text primary key, "organization_id" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null default 'pending', "expires_at" timestamptz not null, "created_at" timestamptz not null default now(), "inviter_id" text not null references "user" ("id") on delete cascade);
create index "invitation_org_idx" on "invitation" ("organization_id");
create index "invitation_email_idx" on "invitation" ("email");
create table "passkey" ("id" text primary key, "name" text, "public_key" text not null, "user_id" text not null references "user" ("id") on delete cascade, "credential_id" text not null, "counter" integer not null, "device_type" text not null, "backed_up" boolean not null, "transports" text, "created_at" timestamptz, "aaguid" text);
