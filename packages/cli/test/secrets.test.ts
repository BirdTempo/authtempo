import { describe, expect, it } from "vitest";
import { describeUrl, guarded, scrub, secretParts } from "../src/output.js";
import { readSecret } from "../src/secrets.js";
import { fakeIo } from "./support/fake-io.js";

const FLAGS = {
  envFlag: "url-env",
  fileFlag: "url-file",
  defaultEnv: "DATABASE_URL",
  what: "the connection string",
};
const CANARY = "postgres://app:s3cret-canary@db.example.com:5432/app";

describe("readSecret (spec 19, the no-secret rule)", () => {
  it("reads the default variable, a named variable, a file, and stdin", () => {
    const io = fakeIo({
      env: { DATABASE_URL: "a-url", OTHER: "b-url" },
      files: { "/work/url.txt": "c-url\n" },
      stdin: "d-url\n",
    });
    const ctx = guarded(io);
    expect(readSecret(ctx, { ...FLAGS, env: undefined, file: undefined })).toBe("a-url");
    expect(readSecret(ctx, { ...FLAGS, env: "OTHER", file: undefined })).toBe("b-url");
    expect(readSecret(ctx, { ...FLAGS, env: undefined, file: "url.txt" })).toBe("c-url");
    expect(readSecret(ctx, { ...FLAGS, env: undefined, file: "-" })).toBe("d-url");
  });

  it("refuses both sources, an unset variable, and an empty file", () => {
    const ctx = guarded(fakeIo({ files: { "/work/empty.txt": "\n" } }));
    expect(() => readSecret(ctx, { ...FLAGS, env: "A", file: "b" })).toThrowError(
      "give --url-env or --url-file, not both",
    );
    expect(() => readSecret(ctx, { ...FLAGS, env: undefined, file: undefined })).toThrowError(
      "set DATABASE_URL to the connection string, or give --url-env or --url-file",
    );
    expect(() => readSecret(ctx, { ...FLAGS, env: undefined, file: "empty.txt" })).toThrowError(
      "--url-file: empty.txt is empty",
    );
  });

  it("refuses a value where a flag wants the name of a variable, and the message holds no part of it", () => {
    const ctx = guarded(fakeIo());
    let message = "";
    try {
      readSecret(ctx, { ...FLAGS, env: CANARY, file: undefined });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("--url-env takes the name of a variable, not a value");
  });

  it("scrubs the value, the password of a URL, and the user and password pair from every line", () => {
    const io = fakeIo({ env: { DATABASE_URL: CANARY } });
    const ctx = guarded(io);
    readSecret(ctx, { ...FLAGS, env: undefined, file: undefined });
    ctx.out(`connecting to ${CANARY}`);
    ctx.err("password authentication failed for app:s3cret-canary");
    ctx.err("the password is s3cret-canary");
    for (const line of [...io.stdout, ...io.stderr]) expect(line).not.toContain("s3cret-canary");
    expect(io.stdout).toEqual(["connecting to ***"]);
  });

  it("names a database by its host, port, and name only", () => {
    expect(describeUrl(CANARY)).toBe("db.example.com:5432/app");
    expect(describeUrl("not a url")).toBe("the database");
  });

  it("drops a part shorter than four characters, so a scrub never mangles every line", () => {
    expect(secretParts("postgres://u:pw@h/d")).toEqual(["postgres://u:pw@h/d", "u:pw"]);
    expect(scrub("pw and u:pw", new Set(secretParts("postgres://u:pw@h/d")))).toBe("pw and ***");
  });
});
