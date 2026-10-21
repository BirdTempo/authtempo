/**
 * The length bounds that core and the importer share (plan 12g fix wave).
 * One source, so the importer cannot write a row that core then refuses to
 * answer. The `./sql` entry re-exports them for `@authtempo/import`.
 */

/**
 * The longest identity subject that social sign-in answers. 255 covers every
 * provider id we know and bounds the row. The MySQL column holds 255
 * characters (ruling 7 of plan 12g).
 */
export const SUBJECT_MAX = 255;

/**
 * The longest credential id of WebAuthn Level 3 (section 5.1, "at most 1023
 * bytes"). The MySQL column holds its base64url form of 1364 characters
 * (ruling 7 of plan 12g).
 */
export const CREDENTIAL_ID_MAX_BYTES = 1023;
