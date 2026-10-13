import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOOK_REFUSED_TEXT,
  hookGuard,
  hookRefusal,
  ORGANIZATION_HOOK_POINTS,
  runAfter,
  runBefore,
  SESSION_HOOK_POINTS,
} from "../src/engine/hooks.js";
import { ERRORS } from "../src/errors.js";
import { respond } from "../src/http/json.js";
import * as core from "../src/index.js";
import { fail, ok, type Result } from "../src/result.js";
import { makeAuth } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A flow with one before hook that refuses with `message`. */
const refusedWith = (message: string) =>
  hookGuard(async (): Promise<Result<true>> => {
    await runBefore(
      "organization.beforeCreate",
      () => {
        throw hookRefusal(message);
      },
      {},
    );
    return ok(true);
  });

describe("hooks config (plan 9d)", () => {
  const make = (hooks: unknown, extra: object = { organizations: {} }) =>
    makeAuth({ ...extra, hooks: hooks as never });

  it("keeps each hook bound to its object", async () => {
    // A symbol key: Object.entries does not list it, so the config check sees one hook.
    const seen = Symbol("seen");
    const group = {
      [seen]: [] as string[],
      beforeCreate() {
        this[seen].push("called");
      },
    };
    const auth = make({ organization: group });
    await auth.config.hooks.organization.beforeCreate?.({} as never);
    expect(group[seen]).toEqual(["called"]);
    expect(make(undefined).config.hooks).toEqual({ organization: {}, session: {} });
  });

  it("refuses a hook that is not a function, a name that is no hook point, an unknown group, and an object that is not plain", () => {
    class Hooks {
      beforeCreate() {}
    }
    const cases: [unknown, string][] = [
      ["hooks", "hooks must be a plain object"],
      [{ request: {} }, "hooks.request is not a hook group; core has organization and session"],
      [
        { organization: { beforeCreate: "x" } },
        "hooks.organization.beforeCreate must be a function",
      ],
      [
        { organization: { beforeCreateOrganization() {} } },
        "hooks.organization.beforeCreateOrganization is not a hook point",
      ],
      [{ session: { beforeDelete() {} } }, "hooks.session.beforeDelete is not a hook point"],
      [{ organization: new Hooks() }, "hooks.organization must be a plain object"],
    ];
    for (const [hooks, message] of cases) expect(() => make(hooks)).toThrow(message);
  });

  it("refuses organization hooks while organizations are off, and keeps session hooks", () => {
    expect(() => make({ organization: { afterCreate() {} } }, {})).toThrow(
      "hooks.organization needs organizations: the hooks would never run",
    );
    expect(
      make({ organization: { afterCreate: undefined } }, {}).config.hooks.organization,
    ).toEqual({});
    const session = make({ session: { afterEnd() {} } }, {}).config.hooks.session;
    expect(Object.keys(session)).toEqual(["afterEnd"]);
  });

  it("names every hook point of the design, and no other", () => {
    expect(Object.keys(ORGANIZATION_HOOK_POINTS).sort()).toEqual(
      [
        "beforeCreate",
        "afterCreate",
        "beforeUpdate",
        "afterUpdate",
        "beforeDelete",
        "afterDelete",
        "beforeAddMember",
        "afterAddMember",
        "beforeUpdateMemberRole",
        "afterUpdateMemberRole",
        "beforeRemoveMember",
        "afterRemoveMember",
        "beforeInvite",
        "afterInvite",
        "afterAcceptInvitation",
        "afterDeclineInvitation",
        "afterRevokeInvitation",
      ].sort(),
    );
    expect(Object.keys(SESSION_HOOK_POINTS).sort()).toEqual([
      "afterCreate",
      "afterEnd",
      "beforeCreate",
    ]);
  });
});

describe("organizations.limits (plan 9d)", () => {
  it("defaults to no limit and keeps the limits it is given", () => {
    expect(makeAuth({ organizations: {} }).config.organizations?.limits).toEqual({
      perUser: null,
      membersPerOrganization: null,
      pendingInvitationsPerOrganization: null,
    });
    expect(
      makeAuth({ organizations: { limits: { perUser: 3, membersPerOrganization: 50 } } }).config
        .organizations?.limits,
    ).toEqual({ perUser: 3, membersPerOrganization: 50, pendingInvitationsPerOrganization: null });
  });

  it("refuses a limit that is not a positive integer, and a key that is no limit", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "3", 2 ** 53])
      expect(() => makeAuth({ organizations: { limits: { perUser: bad as number } } })).toThrow(
        "organizations.limits.perUser must be a positive integer",
      );
    expect(() => makeAuth({ organizations: { limits: { perOrganization: 1 } as never } })).toThrow(
      "organizations.limits.perOrganization is not a limit",
    );
  });
});

describe("the runners (plan 9d)", () => {
  it("answers hook_refused 403 with the message of 1 to 200 code units and no control character", async () => {
    expect(await refusedWith("Choose another name.")).toEqual({
      ok: false,
      code: "hook_refused",
      status: 403,
      message: "Choose another name.",
    });
    expect(await refusedWith("x".repeat(200))).toMatchObject({ message: "x".repeat(200) });
    for (const bad of ["", "x".repeat(201), "line\nbreak", "tab\there", "del\u007f"])
      expect(await refusedWith(bad)).toMatchObject({
        code: "hook_refused",
        message: HOOK_REFUSED_TEXT,
      });
  });

  it("answers hook_failed 500 with no message for any other throw, and logs the hook name and the error name only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await hookGuard(async (): Promise<Result<true>> => {
      await runBefore(
        "organization.beforeCreate",
        () => {
          throw new TypeError("row 42 of the tenant table");
        },
        {},
      );
      return ok(true);
    });
    expect(r).toEqual({ ok: false, code: "hook_failed", status: 500 });
    expect(log.mock.calls).toEqual([
      ["tempo-auth: before hook failed", "organization.beforeCreate", "TypeError"],
    ]);
  });

  it("gives the hook a copy, so a change to the event changes nothing", async () => {
    const event = { organization: { name: "Acme", metadata: { plan: "free" } } };
    await runBefore(
      "organization.beforeCreate",
      (e: typeof event) => {
        e.organization.name = "Changed";
        e.organization.metadata.plan = "pro";
      },
      event,
    );
    expect(event).toEqual({ organization: { name: "Acme", metadata: { plan: "free" } } });
  });

  it("answers the hook's value, and undefined with no hook", async () => {
    expect(await runBefore("session.beforeCreate", () => ({ ip: null }), {})).toEqual({
      ip: null,
    });
    expect(await runBefore("session.beforeCreate", undefined, {})).toBeUndefined();
  });

  it("logs an after hook throw with the hook name, the row id, and the error name, and never throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runAfter(
        "organization.afterCreate",
        async () => {
          throw new RangeError("tenant store down for acme");
        },
        {},
        "ORG1",
      ),
    ).resolves.toBeUndefined();
    expect(log.mock.calls).toEqual([
      ["tempo-auth: after hook failed", "organization.afterCreate", "ORG1", "RangeError"],
    ]);
  });

  it("logs a filtered error name: a name that holds data logs as Error, in both runners (final fix wave M-3)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const leaky = () => {
      const e = new Error("x");
      e.name = "tok_secret123 for acme";
      throw e;
    };
    expect(
      await hookGuard(async (): Promise<Result<true>> => {
        await runBefore("organization.beforeCreate", leaky, {});
        return ok(true);
      }),
    ).toEqual({ ok: false, code: "hook_failed", status: 500 });
    await runAfter("organization.afterCreate", leaky, {}, "ORG1");
    expect(log.mock.calls).toEqual([
      ["tempo-auth: before hook failed", "organization.beforeCreate", "Error"],
      ["tempo-auth: after hook failed", "organization.afterCreate", "ORG1", "Error"],
    ]);
  });

  it("answers hook_refused for a plain Error named HookRefusal, as from a second copy of the package (parked Minor 3)", async () => {
    const r = await hookGuard(async (): Promise<Result<true>> => {
      await runBefore(
        "organization.beforeCreate",
        () => {
          const e = new Error("Other copy.");
          e.name = "HookRefusal";
          throw e;
        },
        {},
      );
      return ok(true);
    });
    expect(r).toEqual({ ok: false, code: "hook_refused", status: 403, message: "Other copy." });
  });

  it("logs a distinct line and calls no hook when the event cannot be copied (parked Minor 4)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const hook = vi.fn();
    const event = { f: () => 1 };
    expect(
      await hookGuard(async (): Promise<Result<true>> => {
        await runBefore("organization.beforeCreate", hook, event);
        return ok(true);
      }),
    ).toEqual({ ok: false, code: "hook_failed", status: 500 });
    await expect(
      runAfter("organization.afterCreate", hook, event, "ORG1"),
    ).resolves.toBeUndefined();
    expect(hook).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([
      ["tempo-auth: hook event copy failed", "organization.beforeCreate", "DataCloneError"],
      ["tempo-auth: hook event copy failed", "organization.afterCreate", "DataCloneError"],
    ]);
  });

  it("passes any error that is not a hook stop", async () => {
    await expect(
      hookGuard(async (): Promise<Result<true>> => {
        throw new Error("storage down");
      }),
    ).rejects.toThrow("storage down");
  });
});

describe("the answer (plan 9d)", () => {
  it("writes the message of a refusal into the JSON body, and nothing more for another code", async () => {
    const res = respond({ ok: false, code: "hook_refused", status: 403, message: "No." });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "hook_refused", message: "No." });
    expect(await respond(fail("not_found")).json()).toEqual({ error: "not_found" });
  });

  it("adds the five codes, and exports the refusal", () => {
    expect(ERRORS).toMatchObject({
      hook_refused: 403,
      hook_failed: 500,
      organization_limit: 409,
      member_limit: 409,
      invitation_limit: 409,
    });
    expect(core.hookRefusal).toBe(hookRefusal);
    expect(core.HOOK_REFUSED_TEXT).toBe(HOOK_REFUSED_TEXT);
    expect(core.hookRefusal("x")).toBeInstanceOf(core.HookRefusal);
  });
});
