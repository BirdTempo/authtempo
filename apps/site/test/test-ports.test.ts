import { describe, expect, it } from "vitest";
import { envFileText, envOf, MAX_SLOT, portOf, SERVICES } from "../../../scripts/test-ports.mjs";

// The port table of the test servers (plan test-servers-per-worktree, Task 1).
// Each worktree that runs tests has its own slot, and each slot its own ports.

describe("the port table of the test servers", () => {
  it("keeps the ports of the running set for slot 0", () => {
    expect(SERVICES.map((s) => [s.name, portOf(0, s.name)])).toEqual([
      ["postgres", 5439],
      ["libsql", 8089],
      ["libsql-cli", 8090],
      ["libsql-cli-compat", 8091],
      ["mysql84", 3384],
      ["mysql97", 3397],
    ]);
  });

  it("answers base plus slot times ten plus the offset for a slot above 0", () => {
    expect(SERVICES.map((s) => portOf(3, s.name))).toEqual([
      20030, 20031, 20032, 20033, 20034, 20035,
    ]);
    expect(portOf(99, "mysql97")).toBe(20995);
  });

  it("gives no port to two slots", () => {
    const seen = new Map<number, string>();
    for (let slot = 0; slot <= MAX_SLOT; slot++)
      for (const s of SERVICES) {
        const port = portOf(slot, s.name);
        expect(seen.get(port), `${port}`).toBeUndefined();
        seen.set(port, `${slot}/${s.name}`);
      }
    expect(seen.size).toBe(600);
  });

  it("refuses an unknown service and a slot outside 0 to 99", () => {
    expect(() => portOf(1, "redis")).toThrow("unknown test service: redis");
    expect(() => portOf(100, "postgres")).toThrow("slot 100 is outside 0 to 99");
    expect(() => portOf(-1, "postgres")).toThrow("slot -1 is outside 0 to 99");
    expect(() => portOf(1.5, "postgres")).toThrow("slot 1.5 is outside 0 to 99");
  });

  it("names each server by its variable, with the port of the slot", () => {
    expect(envOf(2, ["postgres"])).toEqual({
      TEMPO_AUTH_PG_URL: "postgres://tempo:tempo@localhost:20020/tempo_auth",
    });
    expect(envOf(1, ["libsql", "libsql-cli", "libsql-cli-compat", "mysql84", "mysql97"])).toEqual({
      AUTHTEMPO_LIBSQL_URL: "http://127.0.0.1:20011",
      AUTHTEMPO_LIBSQL_CLI_URL: "http://127.0.0.1:20012",
      AUTHTEMPO_LIBSQL_COMPAT_URL: "http://127.0.0.1:20013",
      AUTHTEMPO_MYSQL84_URL: "mysql://root:tempo@127.0.0.1:20014/",
      AUTHTEMPO_MYSQL97_URL: "mysql://root:tempo@127.0.0.1:20015/",
    });
  });

  it("writes the env file as sorted KEY=VALUE lines", () => {
    expect(envFileText(4, ["mysql84", "postgres"])).toBe(
      "AUTHTEMPO_MYSQL84_URL=mysql://root:tempo@127.0.0.1:20044/\n" +
        "TEMPO_AUTH_PG_URL=postgres://tempo:tempo@localhost:20040/tempo_auth\n",
    );
  });
});
