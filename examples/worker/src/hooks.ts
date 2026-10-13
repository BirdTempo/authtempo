import { type HooksConfig, hookRefusal } from "@tempo-auth/core";

/**
 * TEST_MODE only (plan 9d): one before hook and one after hook on
 * organizations, so the end-to-end test proves the hook rules on D1. A real
 * app writes its own tenant row the same way, in its own table of the same
 * database. An app that must keep no organization without its row writes the
 * row in `beforeCreate` with `organization.id` instead.
 */
export function exampleHooks(db: D1Database): HooksConfig {
  return {
    organization: {
      beforeCreate({ organization }) {
        if (organization.slug.startsWith("refused-"))
          throw hookRefusal("This name is not open for sign-up.");
      },
      async afterCreate({ organization, member }) {
        if (organization.slug.startsWith("after-fails-"))
          throw new Error("the tenant store is down");
        await db
          .prepare("INSERT INTO app_tenant (organization_id, owner_id, name) VALUES (?, ?, ?)")
          .bind(organization.id, member.userId, organization.name)
          .run();
      },
    },
  };
}
