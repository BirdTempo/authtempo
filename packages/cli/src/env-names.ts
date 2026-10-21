// The default variable names of the CLI (plan 11c2 fix wave). This module
// imports nothing, so the public entry and the Node modules can both read it.

/**
 * The variable of the connection string when `--url-env` is not given. One
 * source: every command reads it, `authtempo mcp` writes it into the editor
 * entry, and `info` lists it as a secret name.
 */
export const DEFAULT_URL_ENV = "DATABASE_URL";

/** The variable of the operator secret when `--token-env` is not given. One source, as `DEFAULT_URL_ENV`. */
export const DEFAULT_TOKEN_ENV = "AUTHTEMPO_OPERATOR_SECRET";

/**
 * The variable of the libSQL token when neither `--auth-token-env` nor
 * `--auth-token-file` is given (plan 12g Task 6). The token is optional: a
 * local libSQL server takes none.
 */
export const DEFAULT_LIBSQL_TOKEN_ENV = "LIBSQL_AUTH_TOKEN";
