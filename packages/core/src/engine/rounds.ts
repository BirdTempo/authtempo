/**
 * The rounds of a compare-and-set on a row. Each lost round means that a
 * parallel write landed first. An adapter whose `eq` on a date never matches
 * loses every round; the bound stops the loop then. The profile update
 * (plan 12a) reads the same bound. It sits in a module of its own, so that
 * sessions.ts reads it with no import cycle (plan 12a Task 11).
 */
export const ROUNDS = 5;
