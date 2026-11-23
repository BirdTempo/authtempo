import type { EventName } from "../src/observe/events.js";

/**
 * One event of `EVENTS` that no test of core causes, with the reason (plan
 * 12h Task 12). The check run refuses a row whose event a record holds, and
 * a row with no reason. A test that causes the event is better than a row.
 */
export const EVENTS_EXEMPT: readonly { name: EventName; reason: string }[] = [
  {
    name: "secret.low_entropy",
    reason:
      "createAuth writes this line at construction through writeConstructionLine, with or without a sink, and no observer gets it (deviation 7 of plan 12h). default-lines.test.ts pins its text.",
  },
  {
    name: "sso.expiring",
    reason:
      "Plan 13b Task 0 adds the name only. The expiry step of the sweep (Task 10) writes it, and Task 10 removes this row.",
  },
  {
    name: "sweep.sso_expiry_stopped",
    reason:
      "Plan 13b Task 0 adds the name only. The expiry step of the sweep (Task 10) writes it, and Task 10 removes this row.",
  },
];
