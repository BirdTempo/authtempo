import { type HooksConfig, hookRefusal } from "@authtempo/core";

/**
 * TEST_MODE only (plan 9d): hooks that let the end-to-end test prove the
 * hook rules on D1. A real app writes its own tenant row the same way, in
 * its own table of the same database. An app that must keep no organization
 * without its row writes the row in `beforeCreate` with `organization.id`
 * instead. On D1 that write goes through the binding, a separate request
 * that takes no lock.
 */
export function exampleHooks(db: D1Database): HooksConfig {
  const tenant = (organizationId: string, ownerId: string, name: string) =>
    db
      .prepare("INSERT INTO app_tenant (organization_id, owner_id, name) VALUES (?, ?, ?)")
      .bind(organizationId, ownerId, name)
      .run();
  return {
    organization: {
      beforeCreate({ organization }) {
        if (organization.slug.startsWith("refused-"))
          throw hookRefusal("This name is not open for sign-up.");
      },
      async afterCreate({ organization, member }) {
        if (organization.slug.startsWith("after-fails-")) {
          // A marker first, so the test can tell a hook that ran and threw from one that never ran.
          await tenant(organization.id, member.userId, "marker: the after hook ran");
          throw new Error("the tenant store is down");
        }
        await tenant(organization.id, member.userId, organization.name);
      },
      // A refused owner demotion proves the D1 undo of the owner lock stamp (final fix wave M-6).
      beforeUpdateMemberRole({ organization }) {
        if (organization.slug.startsWith("locked-")) throw hookRefusal("Roles are locked here.");
      },
    },
    session: {
      // A refused reset proves the D1 undo of the link's consume (final fix wave M-6).
      beforeCreate({ user, via }) {
        if (via === "password" && user.email.startsWith("hooks-reset-refused"))
          throw hookRefusal("Password sign-in is closed for this account.");
      },
    },
  };
}
