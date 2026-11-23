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
];
