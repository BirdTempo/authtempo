import type { ResolvedConfig } from "../../config.js";
import { sha256Hex } from "../../primitives/crypto.js";
import { newId } from "../../primitives/ids.js";
import { hasControlChar } from "../../primitives/text.js";
import type { SsoTestRunRow } from "../../schema.js";
import { normalizeEmail } from "../users.js";
import { inOrganizationDomains } from "./domains.js";
import type { SsoProfile } from "./resolve.js";

/**
 * The rows of a test run after its start (plan 13a Task 7, spec 6.4). The sign-in files call
 * these functions, so the file imports neither of them: no import cycle.
 *
 * A test run stops before `resolveSsoUser`. It writes no user, identity, session, SCIM row,
 * sign-in audit row, or `sign_in` event. The run row holds a closed code and the names of the
 * attributes, never a value. The address and the name go to a short row of `verification`
 * (`sso-test-result`), so the result page shows them to the person who ran the test.
 */

/** What the completion of a test run answers instead of a sign-in. */
export interface SsoTestDone {
  test: SsoTestRunRow;
}

/** The life of the result row: 15 minutes. The page is read at once after the return. */
export const TEST_RESULT_TTL_MS = 15 * 60_000;
/** The most attribute names and the longest name that a run stores. */
const NAMES_MAX = 64;
const NAME_LENGTH_MAX = 200;
/** The longest address and name that the result row holds. */
const ADDRESS_MAX = 320;
const DISPLAY_NAME_MAX = 200;

/** The identifier of the result row of a run. */
export function resultHash(runId: string): Promise<string> {
  return sha256Hex(`sso-test-result:${runId}`);
}

/** The pending run row of an id, or null. */
export function pendingRun(config: ResolvedConfig, id: string): Promise<SsoTestRunRow | null> {
  return config.storage.findOne("ssoTestRun", [
    { field: "id", op: "eq", value: id },
    { field: "outcome", op: "eq", value: "pending" },
  ]);
}

/** The names of attributes that a run may store: unique, no control character, short, at most 64. */
export function attributeNamesOf(names: readonly string[]): string[] {
  const kept = new Set<string>();
  for (const name of names) {
    if (name.length === 0 || name.length > NAME_LENGTH_MAX || hasControlChar(name)) continue;
    kept.add(name);
    if (kept.size >= NAMES_MAX) break;
  }
  return [...kept].sort();
}

/**
 * Ends a pending run as failed with a closed step name. The update is conditional: a run that
 * another act ended keeps its outcome. The answer is the row as it stands after the call.
 */
export async function failTestRun(
  config: ResolvedConfig,
  run: SsoTestRunRow,
  step: string,
): Promise<SsoTestRunRow> {
  const now = config.clock.now();
  await config.storage.update(
    "ssoTestRun",
    [
      { field: "id", op: "eq", value: run.id },
      { field: "outcome", op: "eq", value: "pending" },
    ],
    { outcome: "failed", step, updatedAt: now },
  );
  return (
    (await config.storage.findOne("ssoTestRun", [{ field: "id", op: "eq", value: run.id }])) ?? run
  );
}

/**
 * Ends a pending run as passed. The attribute names, the claim of the address by a verified
 * domain of the organization, and the result row go in one transaction. A profile with no usable
 * address fails at the step `address`, as the real sign-in would refuse it.
 */
export async function passTestRun(
  config: ResolvedConfig,
  run: SsoTestRunRow,
  profile: SsoProfile,
  attributeNames: readonly string[],
): Promise<SsoTestRunRow> {
  const address = profile.email === null ? null : normalizeEmail(profile.email);
  if (address === null) return failTestRun(config, run, "address");
  const now = config.clock.now();
  await config.storage.transaction(async (tx) => {
    const claimed = await inOrganizationDomains(tx, run.organizationId, address);
    const n = await tx.update(
      "ssoTestRun",
      [
        { field: "id", op: "eq", value: run.id },
        { field: "outcome", op: "eq", value: "pending" },
      ],
      {
        outcome: "passed",
        step: null,
        attributeNames: attributeNamesOf(attributeNames),
        domainClaimed: claimed,
        updatedAt: now,
      },
    );
    if (n !== 1) return;
    await tx.create("verification", {
      id: newId(now),
      purpose: "sso-test-result",
      identifier: run.id,
      valueHash: await resultHash(run.id),
      expiresAt: new Date(now.getTime() + TEST_RESULT_TTL_MS),
      consumedAt: null,
      data: {
        address: address.slice(0, ADDRESS_MAX),
        name: profile.name === null ? null : profile.name.slice(0, DISPLAY_NAME_MAX),
      },
      createdAt: now,
      updatedAt: now,
      secretVersion: config.keyring.current,
    });
  });
  return (
    (await config.storage.findOne("ssoTestRun", [{ field: "id", op: "eq", value: run.id }])) ?? run
  );
}
