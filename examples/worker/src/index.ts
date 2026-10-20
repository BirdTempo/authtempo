import { exampleWorker, getAuth } from "./app.js";

// The deployed entry of the example. The conformance mode of plan 12e has its
// own entry (conformance-worker.ts) and its own config (wrangler.conformance.jsonc),
// so this bundle holds none of its code.
export default exampleWorker(getAuth);
