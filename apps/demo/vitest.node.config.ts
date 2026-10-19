import { defineConfig } from "vitest/config";

// The Node tests of the demo (plan 11b Task 10): the asset copy, the page
// prose, and the files of the build. They read files of the repo, which the
// Workers pool of vitest.config.ts cannot read.
export default defineConfig({
  test: { include: ["test/node/**/*.test.ts"] },
});
