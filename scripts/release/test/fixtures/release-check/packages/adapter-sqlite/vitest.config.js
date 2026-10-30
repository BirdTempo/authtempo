// The conformance reporter, which release-check finds by its module name.
import { conformanceCountReporter } from "../../scripts/conformance-count-reporter.mjs";

export default { test: { reporters: ["default", conformanceCountReporter({ expected: [] })] } };
