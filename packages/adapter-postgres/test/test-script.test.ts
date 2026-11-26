import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

const steps = manifest.scripts.test.split(" && ");

// The peer range of postgres is `^3.4.9 || ^4.1.1`, so the suite runs once
// on each major. The count reporter of a run fails a wrong driver only when
// that run happens. So a test script without the second step passed every
// check, and the range had proof for one major only.
describe("the test script of the package", () => {
  it("runs the suite on postgres 3.4.9 and then on postgres 4.1.1", () => {
    expect(steps).toEqual(["vitest run", "TEMPO_AUTH_PG_DRIVER=4 vitest run"]);
  });

  it("has a peer range that names the two majors that the script runs", () => {
    expect(manifest.peerDependencies.postgres).toBe("^3.4.9 || ^4.1.1");
    expect([manifest.devDependencies.postgres, manifest.devDependencies["postgres-4"]]).toEqual([
      "3.4.9",
      "npm:postgres@4.1.1",
    ]);
  });
});
