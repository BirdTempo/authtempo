import { ROOT_HELP } from "./authtempo.js";
import { KEYS_HELP } from "./keys.js";
import type { HelpText } from "./types.js";

/**
 * Every help text: the program, then each command in the order of the table
 * in main.ts. The docs site reads this list (plan 11c Task 9); the common
 * test holds it to the table.
 */
export const HELP: readonly HelpText[] = [ROOT_HELP, KEYS_HELP];
